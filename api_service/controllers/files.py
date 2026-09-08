from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from .. import config
from ..models import FileOverrideRequest, OverrideResponse, ResultUpdatePayload, SaveToDbPayload
from ..repositories import db_repo
from core import ocr_db
from ..state import FILES, JOBS
from ..utils import derive_table_name
from ..services.runtime_persistence import persist_runtime_manifests
from ..services.override_service import apply_file_override
from ..repositories import job_pages_repo
from ..errors import NotFoundAppError
import logging

logger = logging.getLogger("api")

router = APIRouter()


@router.get("/api/files/{file_id}")
async def get_file(file_id: str):
    stored_file = FILES.get(file_id)
    if not stored_file:
        raise HTTPException(status_code=404, detail="file not found")
    return asdict(stored_file)


@router.get("/api/files/{file_id}/image")
async def get_file_image(file_id: str):
    # 가상 파일(virtual:job_id:page_no) 처리
    if file_id.startswith("virtual:"):
        try:
            parts = file_id.split(":")
            if len(parts) < 3:
                raise HTTPException(status_code=400, detail="invalid virtual file id format")
            
            job_id = parts[1]
            page_no = int(parts[2])
            
            job = JOBS.get(job_id)
            if not job:
                raise HTTPException(status_code=404, detail="job not found")
            
            if not job.pdf_path:
                raise HTTPException(status_code=404, detail="pdf file missing")
            
            pdf_path = Path(job.pdf_path)
            if not pdf_path.exists():
                raise HTTPException(status_code=404, detail="pdf file not found")
            
            # PyMuPDF로 페이지 이미지 추출
            try:
                import fitz
            except ImportError:
                raise HTTPException(status_code=500, detail="PyMuPDF(fitz) is required")
            
            with fitz.open(str(pdf_path)) as doc:
                page_index = page_no - 1
                if page_index < 0 or page_index >= doc.page_count:
                    raise HTTPException(status_code=404, detail="page not found in pdf")
                
                page = doc.load_page(page_index)
                zoom = max(1, int(job.pdf_dpi or 300)) / 72.0
                mat = fitz.Matrix(zoom, zoom)
                
                # 회전 적용
                rotation = job.pdf_rotation
                if rotation == "cw":
                    mat = mat * fitz.Matrix(0, -1, 1, 0)  # 시계방향 90도
                elif rotation == "ccw":
                    mat = mat * fitz.Matrix(0, 1, -1, 0)  # 반시계방향 90도
                elif rotation == "180":
                    mat = mat * fitz.Matrix(-1, 0, 0, -1)  # 180도
                
                pix = page.get_pixmap(matrix=mat, alpha=False)
                png_bytes = pix.tobytes("png")
            
            from fastapi.responses import Response
            return Response(content=png_bytes, media_type="image/png")
            
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"invalid page number: {e}")
        except Exception as e:
            logger.error(f"Failed to load virtual file image: {e}")
            raise HTTPException(status_code=500, detail=f"failed to load virtual file image: {str(e)}")
    
    # 일반 파일 처리
    stored_file = FILES.get(file_id)
    if not stored_file:
        raise HTTPException(status_code=404, detail="file not found")
    path = Path(stored_file.stored_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="image missing")
    return FileResponse(str(path))


@router.get("/api/files/{file_id}/yolo_image")
async def get_yolo_detection_image(file_id: str):
    """
    YOLO detection 결과 이미지 반환
    """
    # YOLO 이미지 경로
    yolo_image_path = config.RESULTS_DIR.parent / "derived" / f"{file_id}_yolo.jpg"
    
    if not yolo_image_path.exists():
        raise HTTPException(status_code=404, detail="YOLO detection image not found")
    
    return FileResponse(str(yolo_image_path), media_type="image/jpeg")


@router.get("/api/files/{file_id}/result")
async def get_file_result(file_id: str):
    stored_file = FILES.get(file_id)
    if not stored_file:
        raise HTTPException(status_code=404, detail="file not found")
    
    # ✅ 먼저 DB에서 최신 결과 가져오기 (우선순위 1)
    try:
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        try:
            cursor = conn.cursor()
            
            # DB에서 result 컬럼 조회
            select_sql = """
            SELECT result FROM ocr_portfolio.files 
            WHERE file_id = %s AND result IS NOT NULL
            """
            cursor.execute(select_sql, (file_id,))
            row = cursor.fetchone()
            
            if row and row[0]:
                # DB에 저장된 result가 있으면 사용
                db_result = json.loads(row[0])
                
                # 메모리 상태 업데이트 (일관성 유지)
                stored_file.result = db_result
                
                # JSON 파일도 업데이트 (백업)
                try:
                    result_path = config.RESULTS_DIR / f"{file_id}.json"
                    result_path.write_text(
                        json.dumps(db_result, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                except Exception as e:
                    logger.warning(f"Failed to update result file for {file_id}: {e}")
                
                cursor.close()
                return {"result": db_result}
            
            cursor.close()
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception as e:
        logger.warning(f"Failed to load result from DB for {file_id}: {e}")
        # DB 조회 실패하면 계속 진행 (파일에서 로드)
    
    # ✅ DB에 없으면 파일에서 결과 로드 (우선순위 2)
    if stored_file.result is None:
        result_path = config.RESULTS_DIR / f"{file_id}.json"
        if result_path.exists():
            try:
                stored_file.result = json.loads(result_path.read_text(encoding="utf-8"))
            except Exception:
                pass
    
    return {"result": stored_file.result}


@router.get("/api/files/{file_id}/check_db")
def check_file_in_db(file_id: str):
    stored_file = FILES.get(file_id)
    if not stored_file:
        raise HTTPException(status_code=404, detail="file not found")

    if not stored_file.result:
        return {"exists": False, "count": 0}

    image_name = (stored_file.result or {}).get("image_name") or stored_file.original_name
    table_name = derive_table_name(image_name)
    current_image_name = (stored_file.result or {}).get("image_name") or stored_file.original_name
    db_title = (current_image_name or image_name or "").strip() or "알 수 없음"

    try:
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        try:
            existing_ids = db_repo.find_existing_doc_ids(
                conn,
                table_name=table_name,
                title=db_title,
                image_name=current_image_name,
            )
            result = {
                "exists": len(existing_ids) > 0,
                "count": len(existing_ids),
                "table_name": table_name
            }
            return result
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception:
        return {"exists": False, "count": 0}


@router.post("/api/files/check_db_batch")
def check_files_in_db_batch(file_ids: List[str]):
    """
    N+1 쿼리 문제 해결을 위한 배치 조회 API
    여러 파일의 DB 존재 여부를 한 번의 쿼리로 확인
    """
    if not file_ids:
        return {"results": {}}
    
    # file_id별로 그룹화 (table_name, title, image_name 기준)
    groups = {}
    for file_id in file_ids:
        stored_file = FILES.get(file_id)
        if not stored_file or not stored_file.result:
            continue
        
        image_name = (stored_file.result or {}).get("image_name") or stored_file.original_name
        table_name = derive_table_name(image_name)
        current_image_name = (stored_file.result or {}).get("image_name") or stored_file.original_name
        db_title = (current_image_name or image_name or "").strip() or "알 수 없음"
        
        key = (table_name, db_title, current_image_name)
        if key not in groups:
            groups[key] = []
        groups[key].append(file_id)
    
    # 그룹별로 한 번씩만 쿼리
    results = {}
    for (table_name, db_title, current_image_name), file_ids_in_group in groups.items():
        # DB 쿼리
        try:
            cfg = db_repo.load_cfg()
            conn = ocr_db.connect(cfg)
            try:
                existing_ids = db_repo.find_existing_doc_ids(
                    conn,
                    table_name=table_name,
                    title=db_title,
                    image_name=current_image_name,
                )
                result = {
                    "exists": len(existing_ids) > 0,
                    "count": len(existing_ids),
                    "table_name": table_name
                }
                
                for fid in file_ids_in_group:
                    results[fid] = result
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
        except Exception:
            for fid in file_ids_in_group:
                results[fid] = {"exists": False, "count": 0}
    
    return {"results": results}


@router.post("/api/files/{file_id}/result")
async def update_file_result(file_id: str, payload: ResultUpdatePayload):
    stored_file = FILES.get(file_id)
    if not stored_file:
        raise HTTPException(status_code=404, detail="file not found")
    if stored_file.result is None:
        stored_file.result = {"image_name": stored_file.original_name, "title": "", "table": []}
    if payload.title is not None:
        stored_file.result["title"] = payload.title
    stored_file.result["table"] = payload.table or []
    if payload.columns is not None:
        stored_file.result["columns"] = payload.columns
    elif "columns" not in stored_file.result:
        try:
            if stored_file.result["table"] and isinstance(stored_file.result["table"][0], dict):
                stored_file.result["columns"] = list(stored_file.result["table"][0].keys())
        except Exception:
            stored_file.result["columns"] = []
    (config.RESULTS_DIR / f"{stored_file.file_id}.json").write_text(
        json.dumps(stored_file.result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    
    # ========== 기존: 전체 매니페스트 저장 (느림) ==========
    # persist_runtime_manifests()
    # =====================================================
    
    # ========== 새로운 방식: DB에 직접 업데이트 (빠름) ==========
    try:
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        try:
            cursor = conn.cursor()
            
            # result와 stage_stats를 JSON으로 변환
            result_json = json.dumps(stored_file.result, ensure_ascii=False)
            stage_stats_json = json.dumps(stored_file.stage_stats, ensure_ascii=False) if stored_file.stage_stats else None
            
            # is_interest를 MySQL BOOLEAN로 변환
            is_interest_value = 1 if stored_file.is_interest else 0
            
            # UPDATE 쿼리 실행
            update_sql = """
            UPDATE ocr_portfolio.files 
            SET result = %s, stage_stats = %s, is_interest = %s
            WHERE file_id = %s
            """
            cursor.execute(update_sql, (result_json, stage_stats_json, is_interest_value, file_id))
            
            conn.commit()
            cursor.close()
            
            logger.debug(f"DB 업데이트 완료: file_id={file_id}")
            
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception as e:
        logger.error(f"DB 업데이트 실패: {e}", exc_info=True)
        # DB 업데이트 실패해도 계속 진행 (폴백으로 JSON 파일은 이미 저장됨)
    # =====================================================
    
    return {"ok": True}


@router.delete("/api/files/{file_id}")
async def delete_file(file_id: str):
    stored_file = FILES.pop(file_id, None)
    if not stored_file:
        raise HTTPException(status_code=404, detail="file not found")

    # 1. DB 데이터 삭제 (존재하는 경우)
    try:
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        try:
            if stored_file.result:
                # DB에서 해당 파일의 데이터 찾기 및 삭제
                image_name = stored_file.result.get("image_name") or stored_file.original_name
                table_name = derive_table_name(image_name)
                current_image_name = stored_file.result.get("image_name") or stored_file.original_name
                db_title = (current_image_name or image_name or "").strip() or "알 수 없음"
                
                # job_id, page_no 기반 또는 doc_key 기반으로 찾기
                job_id_file = getattr(stored_file, "job_id", None)
                page_no = getattr(stored_file, "page_no", None)
                
                existing_ids = []
                if job_id_file and page_no is not None:
                    # PDF 페이지인 경우
                    existing_ids = ocr_db.find_existing_rows_by_job_page(
                        conn, 
                        table_name=table_name, 
                        job_id=job_id_file, 
                        page_no=page_no
                    )
                else:
                    # 개별 이미지인 경우
                    existing_ids = db_repo.find_existing_doc_ids(
                        conn, 
                        table_name=table_name, 
                        title=db_title, 
                        image_name=current_image_name
                    )
                
                if existing_ids:
                    db_repo.delete_doc_ids(conn, table_name=table_name, ids=existing_ids)
                    logger.info(f"Deleted {len(existing_ids)} DB records for file {file_id}")
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception as e:
        logger.error(f"Failed to delete DB records for file {file_id}: {e}")

    # 2. 작업에서 파일 ID 제거
    touched_jobs = []
    for job in JOBS.values():
        if file_id in (job.file_ids or []):
            job.file_ids = [fid for fid in (job.file_ids or []) if fid != file_id]
            touched_jobs.append(job.job_id)

    # ========== 기존: 전체 매니페스트 저장 (느림) ==========
    # persist_runtime_manifests()
    # =====================================================
    
    # ========== 새로운 방식: DB에 직접 업데이트 (빠름) ==========
    try:
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        try:
            cursor = conn.cursor()
            
            # jobs 테이블 업데이트 (file_ids 배열 업데이트)
            for job_id in touched_jobs:
                job = JOBS.get(job_id)
                if job:
                    # file_ids를 JSON으로 변환
                    file_ids_json = json.dumps(job.file_ids or [], ensure_ascii=False)
                    
                    # UPDATE 쿼리 실행
                    update_sql = """
                    UPDATE ocr_portfolio.jobs 
                    SET file_ids = %s
                    WHERE job_id = %s
                    """
                    cursor.execute(update_sql, (file_ids_json, job_id))
            
            conn.commit()
            cursor.close()
            
            logger.debug(f"DB 업데이트 완료: deleted_file_id={file_id}, updated_jobs={touched_jobs}")
            
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception as e:
        logger.error(f"DB 업데이트 실패: {e}", exc_info=True)
        # DB 업데이트 실패해도 계속 진행
    # =====================================================
    
    return {"ok": True, "deleted_file_id": file_id, "updated_jobs": touched_jobs}


@router.post("/api/files/{file_id}/mark_done")
async def mark_file_as_done(file_id: str):
    """
    ERROR 상태의 파일을 DONE으로 수동 변경
    """
    stored_file = FILES.get(file_id)
    if not stored_file:
        raise HTTPException(status_code=404, detail="file not found")
    
    if stored_file.status != "error":
        raise HTTPException(status_code=400, detail="Only error status files can be marked as done")
    
    # 상태 변경
    stored_file.status = "done"
    
    # 결과가 없으면 빈 결과 생성
    if stored_file.result is None:
        stored_file.result = {
            "image_name": stored_file.original_name,
            "title": "",
            "table": [],
            "columns": []
        }
        # 결과를 JSON 파일로 저장
        (config.RESULTS_DIR / f"{stored_file.file_id}.json").write_text(
            json.dumps(stored_file.result, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    
    # ========== 기존: 전체 매니페스트 저장 (느림) ==========
    # persist_runtime_manifests()
    # =====================================================
    
    # ========== 새로운 방식: DB에 직접 업데이트 (빠름) ==========
    try:
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        try:
            cursor = conn.cursor()
            
            # result와 stage_stats를 JSON으로 변환
            result_json = json.dumps(stored_file.result, ensure_ascii=False)
            stage_stats_json = json.dumps(stored_file.stage_stats, ensure_ascii=False) if stored_file.stage_stats else None
            
            # UPDATE 쿼리 실행
            update_sql = """
            UPDATE ocr_portfolio.files 
            SET status = %s, result = %s, stage_stats = %s
            WHERE file_id = %s
            """
            cursor.execute(update_sql, ("done", result_json, stage_stats_json, file_id))
            
            conn.commit()
            cursor.close()
            
            logger.debug(f"DB 업데이트 완료: file_id={file_id}, status=done")
            
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception as e:
        logger.error(f"DB 업데이트 실패: {e}", exc_info=True)
        # DB 업데이트 실패해도 계속 진행
    # =====================================================
    
    return {
        "ok": True,
        "file_id": file_id,
        "file_name": stored_file.original_name,
        "previous_status": "error",
        "new_status": "done",
        "message": "File marked as done"
    }


@router.post("/api/files/{file_id}/override")
async def override_file(file_id: str, payload: FileOverrideRequest):
    """
    파일의 관심 상태 및 회전 값을 변경합니다.
    """
    stored_file = FILES.get(file_id)
    if not stored_file:
        raise HTTPException(status_code=404, detail="file not found")
    
    # 파일이 속한 작업 찾기
    job = None
    page_index = None
    if hasattr(stored_file, 'job_id') and stored_file.job_id:
        job = JOBS.get(stored_file.job_id)
        if job and hasattr(stored_file, 'page_no') and stored_file.page_no:
            page_index = int(stored_file.page_no) - 1
    
    # 오버라이드 적용
    result = apply_file_override(
        stored_file,
        is_interest_raw=payload.is_interest,
        rotation_raw=payload.rotation,
        reprocess=payload.reprocess or False,
        job=job,
        page_index=page_index,
    )
    
    # ========== DB에 직접 업데이트 (files 테이블의 is_interest 필드) ==========
    try:
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        try:
            cursor = conn.cursor()
            
            # is_interest를 MySQL BOOLEAN로 변환
            is_interest_value = 1 if stored_file.is_interest else 0
            
            # UPDATE 쿼리 실행 (files 테이블의 is_interest 필드 업데이트)
            update_sql = """
            UPDATE ocr_portfolio.files 
            SET is_interest = %s
            WHERE file_id = %s
            """
            cursor.execute(update_sql, (is_interest_value, file_id))
            
            conn.commit()
            cursor.close()
            
            logger.debug(f"DB 업데이트 완료: file_id={file_id}, is_interest={stored_file.is_interest}")
            
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception as e:
        logger.error(f"DB 업데이트 실패: {e}", exc_info=True)
        # DB 업데이트 실패해도 계속 진행 (메모리 상태는 이미 변경됨)
    # =====================================================
    
    return result


@router.post("/api/files/{file_id}/mark_non_interest")
async def mark_file_as_non_interest(file_id: str):
    """
    PDF 페이지를 비관심으로 변경하고 관련 데이터 정리
    - OCR 처리 취소
    - DB 데이터 삭제
    - 이미지는 유지
    - 상태는 'done'으로 변경
    """
    stored_file = FILES.get(file_id)
    if not stored_file:
        raise HTTPException(status_code=404, detail="file not found")
    
    # PDF 페이지만 처리
    if getattr(stored_file, "kind", None) != "pdf_page":
        raise HTTPException(status_code=400, detail="Only PDF pages can be marked as non-interest")
    
    job_id = getattr(stored_file, "job_id", None)
    page_no = getattr(stored_file, "page_no", None)
    
    if not job_id or not page_no:
        raise HTTPException(status_code=400, detail="Invalid PDF page: missing job_id or page_no")
    
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    # 1. 파일 상태 변경
    stored_file.status = "done"
    stored_file.is_interest = False
    stored_file.error = None
    
    # 2. job_pages 상태 변경
    page_index = int(page_no) - 1
    job_pages_repo.update_page_status(job_id, page_index, "done")
    job_pages_repo.update_page_classification(job_id, page_index, False, None)
    job_pages_repo.update_page_is_interest(job_id, page_index, False)
    
    # 3. DB 데이터 삭제 (존재하는 경우)
    try:
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        try:
            # 여러 가능한 테이블에서 시도 (image_name 기반, title 기반, 기본 테이블)
            possible_tables = ["ocr_results"]  # 기본 테이블
            
            if stored_file.result:
                image_name = stored_file.result.get("image_name") or stored_file.original_name
                title = stored_file.result.get("title") or stored_file.original_name
                
                # image_name 기반 테이블
                table_from_image = derive_table_name(image_name)
                if table_from_image not in possible_tables:
                    possible_tables.append(table_from_image)
                
                # title 기반 테이블
                table_from_title = derive_table_name(title)
                if table_from_title not in possible_tables:
                    possible_tables.append(table_from_title)
                
                # 한글이 제거된 버전도 시도 (MySQL 테이블 이름이 소문자로 저장되는 경우)
                import re
                table_from_image_no_korean = re.sub(r"[^a-zA-Z0-9_-]", "_", table_from_image).lower()
                if table_from_image_no_korean not in possible_tables and table_from_image_no_korean != table_from_image:
                    possible_tables.append(table_from_image_no_korean)
                
                table_from_title_no_korean = re.sub(r"[^a-zA-Z0-9_-]", "_", table_from_title).lower()
                if table_from_title_no_korean not in possible_tables and table_from_title_no_korean != table_from_title:
                    possible_tables.append(table_from_title_no_korean)
            
            total_deleted = 0
            for table_name in possible_tables:
                try:
                    logger.info(f"Attempting to delete DB records for file {file_id} from table {table_name} (job_id={job_id}, page_no={page_no})")
                    
                    # job_id, page_no로 기존 레코드 찾기
                    existing_ids = ocr_db.find_existing_rows_by_job_page(
                        conn,
                        table_name=table_name,
                        job_id=job_id,
                        page_no=page_no
                    )
                    
                    logger.info(f"Found {len(existing_ids)} existing DB records in table {table_name} for file {file_id}")
                    
                    if existing_ids:
                        # 기존 레코드 삭제
                        deleted_count = db_repo.delete_doc_ids(conn, table_name=table_name, ids=existing_ids)
                        total_deleted += deleted_count
                        logger.info(f"Deleted {deleted_count} DB records from table {table_name} for file {file_id} (job_id={job_id}, page_no={page_no})")
                except Exception as e:
                    logger.warning(f"Failed to delete from table {table_name}: {e}")
                    continue
            
            if total_deleted > 0:
                logger.info(f"Total deleted {total_deleted} DB records for file {file_id} (job_id={job_id}, page_no={page_no})")
            else:
                logger.info(f"No DB records found to delete for file {file_id} (job_id={job_id}, page_no={page_no})")
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception as e:
        logger.error(f"Failed to delete DB records for file {file_id}: {e}", exc_info=True)
        # DB 삭제 실패해도 계속 진행
    
    # 4. 메모리에서 테이블 데이터 비우기
    if stored_file.result:
        stored_file.result["table"] = []
        stored_file.result["rows"] = []
        # 결과 파일도 업데이트
        try:
            (config.RESULTS_DIR / f"{stored_file.file_id}.json").write_text(
                json.dumps(stored_file.result, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logger.warning(f"Failed to update result file for {file_id}: {e}")
    
    # ========== 기존: 전체 매니페스트 저장 (느림) ==========
    # persist_runtime_manifests()
    # =====================================================
    
    # ========== 새로운 방식: DB에 직접 업데이트 (빠름) ==========
    try:
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        try:
            cursor = conn.cursor()
            
            # result와 stage_stats를 JSON으로 변환
            result_json = json.dumps(stored_file.result, ensure_ascii=False)
            stage_stats_json = json.dumps(stored_file.stage_stats, ensure_ascii=False) if stored_file.stage_stats else None
            
            # is_interest를 MySQL BOOLEAN로 변환
            is_interest_value = 1 if stored_file.is_interest else 0
            
            # UPDATE 쿼리 실행
            update_sql = """
            UPDATE ocr_portfolio.files 
            SET status = %s, is_interest = %s, error = %s, result = %s, stage_stats = %s
            WHERE file_id = %s
            """
            cursor.execute(update_sql, ("done", is_interest_value, None, result_json, stage_stats_json, file_id))
            
            conn.commit()
            cursor.close()
            
            logger.debug(f"DB 업데이트 완료: file_id={file_id}, status=done, is_interest=False")
            
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception as e:
        logger.error(f"DB 업데이트 실패: {e}", exc_info=True)
        # DB 업데이트 실패해도 계속 진행
@router.post("/api/files/{file_id}/save_to_db")
def save_to_db(
    file_id: str, 
    overwrite: bool = False, 
    user_id: str = "unknown",
    payload: Optional[SaveToDbPayload] = None
):
    """
    OCR 결과를 DB에 저장합니다.
    
    Args:
        file_id: 파일 ID
        overwrite: 기존 데이터 덮어쓰기 여부
        user_id: 사용자 ID (히스토리용)
        payload: 직접 전달되는 편집 데이터 (선택사항)
                - payload가 제공되면 메모리 상태 대신 이 데이터를 사용
                - payload가 없으면 기존처럼 메모리 상태(stored_file.result) 사용
    """
    stored_file = FILES.get(file_id)
    if not stored_file:
        raise HTTPException(status_code=404, detail="File not found")
    
    # ✅ payload가 제공되면 직접 사용, 없으면 메모리 상태 사용
    if payload is not None:
        # 직접 전달된 데이터 사용
        result_for_db = {
            "title": payload.title or (stored_file.result or {}).get("title", ""),
            "table": payload.table or [],
            "columns": payload.columns or [],
            "image_name": payload.image_name or (stored_file.result or {}).get("image_name") or stored_file.original_name
        }
        # 메모리 상태도 업데이트 (일관성 유지) - payload 데이터 우선
        if stored_file.result is None:
            stored_file.result = {}
        # payload 데이터로 메모리 상태 업데이트 (역순으로 업데이트하여 payload 우선)
        stored_file.result["title"] = result_for_db["title"]
        stored_file.result["table"] = result_for_db["table"]
        stored_file.result["columns"] = result_for_db["columns"]
        stored_file.result["image_name"] = result_for_db["image_name"]
    else:
        # 기존 방식: 메모리 상태 사용
        if not stored_file.result:
            raise HTTPException(status_code=400, detail="No OCR result")
        result_for_db = dict(stored_file.result or {})

    cfg = db_repo.load_cfg()
    conn = ocr_db.connect(cfg)
    try:
        image_name = result_for_db.get("image_name") or stored_file.original_name
        table_name = derive_table_name(image_name)
        current_image_name = result_for_db.get("image_name") or stored_file.original_name
        # ✅ title이 없으면 doc_key 사용, 있으면 payload의 title 우선
        if not result_for_db.get("title"):
            doc_key = (current_image_name or "").strip() or "알 수 없음"
            result_for_db["title"] = doc_key
        else:
            doc_key = result_for_db["title"]

        # 🔑 핵심: "table" 이 있으면 "rows" 로 복사
        if "table" in result_for_db and "rows" not in result_for_db:
            result_for_db["rows"] = result_for_db["table"]

        job_id = getattr(stored_file, "job_id", None)
        page_no = getattr(stored_file, "page_no", None)
        has_page_identity = job_id is not None and page_no is not None

        # ✅ 기존 레코드 찾기 (job_id, page_no 기반 또는 doc_key 기반)
        existing_ids = []
        if job_id and page_no is not None:
            # PDF 페이지인 경우: job_id, page_no로 찾기
            existing_ids = ocr_db.find_existing_rows_by_job_page(
                conn, 
                table_name=table_name, 
                job_id=job_id, 
                page_no=page_no
            )
        else:
            # 개별 이미지인 경우: doc_key, image_name으로 찾기
            existing_ids = db_repo.find_existing_doc_ids(conn, table_name=table_name, title=doc_key, image_name=current_image_name)
            if existing_ids and not overwrite:
                return JSONResponse(
                    status_code=409,
                    content={
                        "conflict": True,
                        "message": "기존 문서가 존재합니다. 덮어씌울까요?",
                        "doc_key": doc_key,
                        "count": len(existing_ids),
                    },
                )

        # ✅ 기존 데이터 읽기 (diff용)
        old_rows = []
        if existing_ids:
            old_rows = ocr_db.fetch_rows_for_doc(conn, table_name, doc_key=doc_key)
            # 기존 레코드 삭제
            db_repo.delete_doc_ids(conn, table_name=table_name, ids=existing_ids)

        # ✅ 새 데이터 저장
        logger.debug(f"저장할 데이터: table_rows 개수 = {len(result_for_db.get('rows', []))}")
        logger.debug(f"저장할 데이터: result_for_db keys = {list(result_for_db.keys())}")
        logger.debug(f"저장할 데이터: job_id = {job_id}, page_no = {page_no}")
        
        rows_inserted = int(
            db_repo.save_ocr_wide_rows(
                conn,
                result_for_db,
                image_path=stored_file.stored_path,
                table_name=table_name,
                doc_key=doc_key,
                job_id=getattr(stored_file, "job_id", None),
                page_no=getattr(stored_file, "page_no", None),
                upsert_strategy="update",
            )
        )
        
        logger.debug(f"저장 완료: rows_inserted = {rows_inserted}")

        # ✅ Diff 계산 및 히스토리 저장
        new_rows = result_for_db.get("rows", [])
        diffs = ocr_db.build_cell_diffs(old_rows=old_rows, new_rows=new_rows)
        history_saved = ocr_db.save_edit_history(
            conn=conn,
            doc_key=doc_key,
            diffs=diffs,
            user_id=user_id,
        )

        logger.debug(" OCR 결과 키: %s", list(result_for_db.keys()))
        logger.debug(" old_rows 전체 데이터: %r", old_rows)
        logger.debug(" new_rows 전체 데이터: %r", new_rows)
        logger.debug(" diffs 내용: %r", diffs)
        logger.debug(" diffs 길이: %r", len(diffs))

        return {
            "ok": True,
            "table": table_name,
            "doc_key": doc_key,
            "rows_inserted": rows_inserted,
            "changes": len(diffs),
            "history_saved": history_saved,
        }

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        try:
            conn.close()
        except Exception:
            pass
