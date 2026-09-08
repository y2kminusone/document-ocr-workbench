from __future__ import annotations

import base64
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .. import config
from ..clients import call_ocr_from_yolo, call_yolo_detect
from ..models import StoredFile
from ..state import FILES, FILE_SOURCE_INDEX
from ..utils import format_exception_for_log
from ..errors import OcrError, ResultPersistError, YoloError
from .runtime_persistence import persist_runtime_manifests
from .pipeline_debug_service import build_stage, error_meta_from_exception, finalize_debug, stage_stats_from_result


def make_file_source_key(job_id: Optional[str], page_no: Optional[int]) -> Optional[str]:
    if not job_id or page_no is None:
        return None
    try:
        page = int(page_no)
    except Exception:
        return None
    return f"{str(job_id)}:{page}"


def find_file_by_source(job_id: Optional[str], page_no: Optional[int]) -> Optional[StoredFile]:
    source_key = make_file_source_key(job_id, page_no)
    if not source_key:
        return None
    file_id = FILE_SOURCE_INDEX.get(source_key)
    if file_id and file_id in FILES:
        return FILES[file_id]
    for stored in FILES.values():
        if getattr(stored, "job_id", None) == job_id and int(getattr(stored, "page_no", -1) or -1) == int(page_no):
            FILE_SOURCE_INDEX[source_key] = stored.file_id
            return stored
    return None


def create_stored_file(
    kind: str,
    original_name: str,
    stored_path: Path,
    rotation: Optional[str],
    *,
    job_id: Optional[str] = None,
    page_no: Optional[int] = None,
    is_interest: Optional[bool] = None,
) -> StoredFile:
    import uuid

    source_key = make_file_source_key(job_id, page_no)
    if source_key:
        existing = find_file_by_source(job_id, page_no)
        if existing is not None:
            return existing

    file_id = uuid.uuid4().hex
    stored_file = StoredFile(
        file_id=file_id,
        kind=kind,
        original_name=original_name,
        stored_path=str(stored_path),
        rotation=rotation,
        job_id=job_id,
        page_no=int(page_no) if page_no is not None else None,
        is_interest=is_interest,
    )
    FILES[file_id] = stored_file
    if source_key:
        FILE_SOURCE_INDEX[source_key] = file_id
    
    # ========== DB에 직접 INSERT ==========
    try:
        from core import ocr_db
        from ..repositories import db_repo
        
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        
        try:
            cursor = conn.cursor()
            
            # Boolean 필드 변환
            is_interest_value = 1 if is_interest else 0 if is_interest is not None else None
            
            # INSERT 쿼리 실행
            cursor.execute("""
                INSERT INTO ocr_portfolio.files 
                (file_id, kind, original_name, stored_path, created_ms, status, 
                 error, rotation, result, job_id, page_no, is_interest, stage_stats)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                file_id, kind, original_name, str(stored_path), stored_file.created_ms, 
                stored_file.status, stored_file.error, rotation, None, 
                job_id, stored_file.page_no, is_interest_value, None
            ))
            
            conn.commit()
            cursor.close()
            
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception as e:
        # DB INSERT 실패해도 계속 진행 (JSON 파일은 저장됨)
        import logging
        logger = logging.getLogger("api")
        logger.error(f"DB INSERT 실패 (file_id={file_id}): {e}", exc_info=True)
    # ==========================================
    
    persist_runtime_manifests()
    return stored_file


def _build_original_image_data_url(image_path: Path) -> str:
    raw = image_path.read_bytes()
    encoded = base64.b64encode(raw).decode("utf-8")
    return f"data:image/png;base64,{encoded}"


def make_empty_result(stored_file: StoredFile, debug: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    result = {
        "image_name": stored_file.original_name,
        "title": stored_file.original_name,
        "table": [],
        "columns": [],
    }
    if isinstance(debug, dict):
        result["_debug"] = debug
    return result


def process_file(file_id: str) -> None:
    stored_file = FILES[file_id]
    started = time.perf_counter()
    image_path = Path(stored_file.stored_path)
    debug: Dict[str, Any] = {
        "pipeline_started_ms": int(time.time() * 1000),
        "rotation": stored_file.rotation,
        "is_interest": stored_file.is_interest,
        "stages": {},
    }

    try:
        yolo_t0 = time.perf_counter()
        try:
            yolo = call_yolo_detect(image_path, stored_file.rotation, file_id=stored_file.file_id)
            debug["stages"]["yolo"] = build_stage(
                "ok",
                int((time.perf_counter() - yolo_t0) * 1000),
                extra={"fallback_used": False},
            )
        except Exception as yolo_exc:
            wrapped = YoloError("YOLO detect request failed", detail=str(yolo_exc), retryable=True)
            debug["stages"]["yolo"] = build_stage(
                "error",
                int((time.perf_counter() - yolo_t0) * 1000),
                error=wrapped.message,
                error_code=wrapped.code,
                retryable=wrapped.retryable,
                extra={"fallback_used": True},
            )
            yolo = {
                "success": False,
                "chemical_crops": [],
                "table_crops": [],
                "title_crops": [],
                "detections": [],
                "original_image": _build_original_image_data_url(image_path),
                "image_size": None,
            }

        ocr_t0 = time.perf_counter()
        try:
            ocr = call_ocr_from_yolo(yolo, image_name=stored_file.original_name)
            debug["stages"]["ocr"] = build_stage("ok", int((time.perf_counter() - ocr_t0) * 1000))
        except Exception as ocr_exc:
            wrapped = OcrError("OCR request failed", detail=str(ocr_exc), retryable=True)
            debug["stages"]["ocr"] = build_stage(
                "error",
                int((time.perf_counter() - ocr_t0) * 1000),
                error=wrapped.message,
                error_code=wrapped.code,
                retryable=wrapped.retryable,
            )
            raise wrapped

        if not ocr.get("success", True):
            raise OcrError(ocr.get("error") or "OCR failed", retryable=False)

        table = ocr.get("table") or []
        columns: List[str] = []
        try:
            if isinstance(table, list) and table and isinstance(table[0], dict):
                columns = list(table[0].keys())
        except Exception:
            columns = []

        debug = finalize_debug(
            debug,
            started_at=started,
            fallback_used=bool((debug.get("stages", {}).get("yolo", {}) or {}).get("fallback_used")),
            decision="processed",
        )
        stored_file.result = {
            "image_name": stored_file.original_name,
            "title": stored_file.original_name,
            "table": table,
            "columns": columns,
            "_debug": debug,
        }
        try:
            (config.RESULTS_DIR / f"{stored_file.file_id}.json").write_text(
                json.dumps(stored_file.result, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as persist_exc:
            raise ResultPersistError("Failed to persist OCR result", detail=str(persist_exc), retryable=True)
        stored_file.status = "done"
        stored_file.error = None
        stored_file.stage_stats = stage_stats_from_result(stored_file.result, debug.get("stages", {}))
        
        # ========== DB UPDATE 추가 ==========
        try:
            from core import ocr_db
            from ..repositories import db_repo
            
            cfg = db_repo.load_cfg()
            conn = ocr_db.connect(cfg)
            
            try:
                cursor = conn.cursor()
                
                # result JSON 변환
                result_json = json.dumps(stored_file.result, ensure_ascii=False)
                stage_stats_json = json.dumps(stored_file.stage_stats, ensure_ascii=False)
                
                # UPDATE 쿼리 실행
                cursor.execute("""
                    UPDATE ocr_portfolio.files 
                    SET status=%s, error=%s, result=%s, stage_stats=%s
                    WHERE file_id=%s
                """, (
                    stored_file.status, 
                    stored_file.error, 
                    result_json, 
                    stage_stats_json, 
                    stored_file.file_id
                ))
                
                conn.commit()
                cursor.close()
                
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
        except Exception as e:
            # DB UPDATE 실패해도 계속 진행 (JSON 파일은 저장됨)
            import logging
            logger = logging.getLogger("api")
            logger.error(f"DB UPDATE 실패 (file_id={stored_file.file_id}): {e}", exc_info=True)
        # ==========================================
        
        persist_runtime_manifests()
    except Exception as exc:
        debug["error"] = str(exc)
        err_meta = error_meta_from_exception(exc)
        debug["error_code"] = err_meta.get("error_code")
        debug["retryable"] = err_meta.get("retryable")
        if err_meta.get("failed_stage"):
            debug["failed_stage"] = err_meta.get("failed_stage")
        debug = finalize_debug(
            debug,
            started_at=started,
            fallback_used=bool((debug.get("stages", {}).get("yolo", {}) or {}).get("fallback_used")),
            decision="failed",
        )
        if stored_file.result is None:
            stored_file.result = make_empty_result(stored_file, debug=debug)
        else:
            stored_file.result["_debug"] = debug
        try:
            (config.RESULTS_DIR / f"{stored_file.file_id}.json").write_text(
                json.dumps(stored_file.result, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass
        stored_file.status = "error"
        stored_file.error = format_exception_for_log(exc)
        stored_file.stage_stats = stage_stats_from_result(stored_file.result, debug.get("stages", {}))
        
        # ========== DB UPDATE 추가 ==========
        try:
            from core import ocr_db
            from ..repositories import db_repo
            
            cfg = db_repo.load_cfg()
            conn = ocr_db.connect(cfg)
            
            try:
                cursor = conn.cursor()
                
                # result JSON 변환
                result_json = json.dumps(stored_file.result, ensure_ascii=False)
                stage_stats_json = json.dumps(stored_file.stage_stats, ensure_ascii=False)
                
                # UPDATE 쿼리 실행
                cursor.execute("""
                    UPDATE ocr_portfolio.files 
                    SET status=%s, error=%s, result=%s, stage_stats=%s
                    WHERE file_id=%s
                """, (
                    stored_file.status, 
                    stored_file.error, 
                    result_json, 
                    stage_stats_json, 
                    stored_file.file_id
                ))
                
                conn.commit()
                cursor.close()
                
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
        except Exception as e:
            # DB UPDATE 실패해도 계속 진행 (JSON 파일은 저장됨)
            import logging
            logger = logging.getLogger("api")
            logger.error(f"DB UPDATE 실패 (file_id={stored_file.file_id}): {e}", exc_info=True)
        # ==========================================
        
        persist_runtime_manifests()
