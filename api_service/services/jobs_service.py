from __future__ import annotations

import json
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor, wait
from pathlib import Path
from typing import Any, Dict, Optional

try:
    import fitz  # type: ignore
except Exception:
    fitz = None

from .. import config
from ..clients import call_doc_filter_image
from ..models import Job
from .. import state
from ..state import FILES, JOBS
from ..utils import maybe_rotation_from_doc_index
from ..utils import format_exception_for_log, classify_exception
from ..repositories import job_pages_repo
from .files_service import create_stored_file, process_file, find_file_by_source, make_empty_result
from .runtime_persistence import persist_runtime_manifests

MAX_JOB_LOGS = 200

MAX_SYSTEM_LOGS = 500
PAGE_MAX_ATTEMPTS = 3
PAGE_LEASE_SECONDS = 120




def _page_retry_log_message(page_no: int, reason: str, exc: Exception, final: bool) -> str:
    action = "최종 실패" if final else "재시도 예정"
    detail = str(exc or "")
    if reason.startswith("TIMEOUT"):
        cause = "요청 시간 초과"
    elif reason.startswith("MEMORY"):
        cause = "메모리 부족"
    elif reason.startswith("NETWORK"):
        cause = "네트워크 연결 문제"
    elif reason.startswith("HTTP"):
        cause = "외부 서비스 HTTP 오류"
    elif reason.startswith("FILE_NOT_FOUND"):
        cause = "파일 누락"
    elif reason.startswith("PERMISSION"):
        cause = "권한 오류"
    elif reason.startswith("TLS"):
        cause = "TLS/인증서 오류"
    else:
        cause = f"알 수 없는 오류({reason})"
    return f"페이지 {page_no} {action} (원인={cause}): {detail}"
    
def _wait_if_paused(job: Job) -> bool:
    """작업이 paused 상태라면 cancel 요청 또는 resume 전까지 대기한다."""
    announced = False
    while job.status == "paused" and not job.cancel_requested:
        if not announced:
            add_job_log(job, "info", "pause", "작업이 일시정지되었습니다. 재개 요청을 기다립니다.")
            announced = True
        time.sleep(0.2)
    if announced and not job.cancel_requested:
        add_job_log(job, "info", "resume", "작업이 재개되었습니다.")
    return announced


def add_system_log(job: Job, entry: dict) -> None:
    try:
        state.SYSTEM_LOG_SEQ = int(getattr(state, "SYSTEM_LOG_SEQ", 0) or 0) + 1
    except Exception:
        state.SYSTEM_LOG_SEQ = 1

    item = {
        "seq": state.SYSTEM_LOG_SEQ,
        "ts_ms": entry.get("ts_ms"),
        "level": entry.get("level"),
        "stage": entry.get("stage"),
        "message": entry.get("message"),
        "job_id": getattr(job, "job_id", None),
        "job_kind": getattr(job, "kind", None),
        "job_name": getattr(job, "name", None),
    }
    if not isinstance(state.SYSTEM_LOGS, list):
        state.SYSTEM_LOGS = []
    state.SYSTEM_LOGS.append(item)
    if len(state.SYSTEM_LOGS) > MAX_SYSTEM_LOGS:
        del state.SYSTEM_LOGS[:-MAX_SYSTEM_LOGS]


def add_job_log(job: Job, level: str, stage: str, message: str) -> None:
    try:
        job.log_seq = int(getattr(job, "log_seq", 0) or 0) + 1
    except Exception:
        job.log_seq = 1

    entry = {
        "seq": job.log_seq,
        "ts_ms": int(time.time() * 1000),
        "level": (level or "INFO").upper(),
        "stage": (stage or "SYSTEM").upper(),
        "message": str(message or ""),
    }
    if not isinstance(job.logs, list):
        job.logs = []
    job.logs.append(entry)
    if len(job.logs) > MAX_JOB_LOGS:
        del job.logs[:-MAX_JOB_LOGS]
    
    # ========== DB UPDATE 추가 ==========
    try:
        from core import ocr_db
        from ..repositories import db_repo
        
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        
        try:
            cursor = conn.cursor()
            
            # JSON 필드 변환
            progress_json = json.dumps(job.progress, ensure_ascii=False)
            logs_json = json.dumps(job.logs, ensure_ascii=False)
            
            # Boolean 필드 변환
            cancel_requested = 1 if job.cancel_requested else 0
            pdf_scan_done = 1 if job.pdf_scan_done else 0
            
            # UPDATE 쿼리 실행
            cursor.execute("""
                UPDATE ocr_portfolio.jobs 
                SET status=%s, progress=%s, error=%s, cancel_requested=%s, 
                    pdf_scan_done=%s, logs=%s
                WHERE job_id=%s
            """, (
                job.status, 
                progress_json, 
                job.error, 
                cancel_requested, 
                pdf_scan_done, 
                logs_json, 
                job.job_id
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
        logger.error(f"DB UPDATE 실패 (job_id={job.job_id}): {e}", exc_info=True)
    # ==========================================
    
    # 성능 최적화: 시스템 로그와 manifest 저장 비활성화
    # add_system_log(job, entry)
    # persist_runtime_manifests()


def prepare_files_retry(job: Job) -> int:
    reset = 0
    with state.STATE_LOCK:
        for file_id in list(job.file_ids):
            stored = FILES.get(file_id)
            if not stored:
                continue
            if stored.status == "done":
                continue
            # processing 상태는 건너뜀 (이미 처리중이거나 완료될 것으로 간주)
            if stored.status == "error":
                stored.status = "queued"
                stored.error = None
                reset += 1
            elif stored.status == "cancelled":
                stored.status = "queued"
                stored.error = None
                reset += 1
            elif stored.status == "queued":
                reset += 1
    return reset


def run_files_job(job: Job) -> None:
    if job.status != "paused":
        job.status = "processing"
    job.error = None
    total_files = len(job.file_ids)
    
    with state.STATE_LOCK:
        done_before = sum(1 for fid in job.file_ids if (FILES.get(fid) and FILES[fid].status == "done"))
    
    job.progress = {
        "total": total_files,
        "done": done_before,
        "remaining": max(0, total_files - done_before),
        "retrying": max(0, total_files - done_before),
    }
    add_job_log(job, "info", "process", f"파일 처리 시작 ({total_files}개)")

    try:
        for idx, file_id in enumerate(job.file_ids, start=1):
            if _wait_if_paused(job):
                job.status = "processing"
            if job.cancel_requested:
                job.status = "cancelled"
                job.error = "사용자가 작업을 중지했습니다."
                add_job_log(job, "warn", "cancel", "사용자 요청으로 작업이 중지되었습니다.")
                return

            with state.STATE_LOCK:
                stored = FILES.get(file_id)
                if stored and stored.status == "done":
                    continue
                file_name = stored.original_name if stored else f"file {idx}"
                
                # processing 상태로 변경
                if stored:
                    stored.status = "processing"
                    stored.error = None
            
            persist_runtime_manifests()
            
            add_job_log(job, "info", "ocr", f"{idx}/{total_files} 처리 중: {file_name}")
            process_file(file_id)
            job.progress["done"] += 1
            total = int(job.progress.get("total", total_files) or total_files)
            done = int(job.progress.get("done", 0) or 0)
            job.progress["remaining"] = max(0, total - done)
            job.progress["retrying"] = max(0, total - done)

            with state.STATE_LOCK:
                stored = FILES.get(file_id)
                if stored and stored.status == "done":
                    add_job_log(job, "success", "ocr", f"{idx}/{total_files} 완료: {stored.original_name}")
                elif stored and stored.status == "error":
                    add_job_log(job, "error", "ocr", f"{idx}/{total_files} 실패: {stored.original_name}")

        with state.STATE_LOCK:
            has_errors = any(FILES[fid].status == "error" for fid in job.file_ids)
        
        if has_errors:
            job.status = "error"
            job.error = "일부 파일 처리 실패"
            add_job_log(job, "error", "complete", "작업 종료: 일부 파일 처리에 실패했습니다.")
        else:
            job.status = "done"
            add_job_log(job, "success", "complete", "작업 완료: 모든 파일 처리가 끝났습니다.")
    except Exception as exc:
        job.status = "error"
        formatted = format_exception_for_log(exc)
        job.error = formatted
        add_job_log(job, "error", "fail", f"작업 실패: {formatted}")


def _render_pdf_page_to_png_bytes(doc: Any, page_index: int, dpi: int) -> bytes:
    page = doc.load_page(int(page_index))
    zoom = max(1, int(dpi)) / 72.0
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    return pix.tobytes("png")


def _sync_pdf_progress(job: Job) -> dict:
    stats = job_pages_repo.get_job_page_stats(job.job_id)
    total = sum(v for k, v in stats.items() if k not in ("interest", "retrying"))
    done = int(stats.get("done", 0) or 0)
    queued = int(stats.get("queued", 0) or 0)
    processing = int(stats.get("processing", 0) or 0)
    error = int(stats.get("error", 0) or 0)
    interest = int(stats.get("interest", 0) or 0)
    retrying = int(stats.get("retrying", 0) or 0)
    remaining = max(0, total - done - error)
    
    # 성능 최적화: 락 범위 최소화
    ocr_done = 0
    file_ids_snapshot = list(job.file_ids or [])  # 락 밖에서 복사
    
    with state.STATE_LOCK:
        for fid in file_ids_snapshot:  # 복사본 사용
            stored = FILES.get(fid)
            if stored and bool(getattr(stored, "is_interest", False)) and stored.status == "done":
                ocr_done += 1
    
    job.progress = {
        "total": total,
        "done": done,
        "queued": queued,
        "processing": processing,
        "error": error,
        "remaining": remaining,
        "retrying": retrying,
        "interest": interest,
        "ocr_total": interest,
        "ocr_done": ocr_done,
    }
    
    # ========== DB UPDATE 추가 ==========
    try:
        from core import ocr_db
        from ..repositories import db_repo
        
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        
        try:
            cursor = conn.cursor()
            
            # JSON 필드 변환
            progress_json = json.dumps(job.progress, ensure_ascii=False)
            logs_json = json.dumps(job.logs, ensure_ascii=False)
            
            # Boolean 필드 변환
            cancel_requested = 1 if job.cancel_requested else 0
            pdf_scan_done = 1 if job.pdf_scan_done else 0
            
            # UPDATE 쿼리 실행
            cursor.execute("""
                UPDATE ocr_portfolio.jobs 
                SET status=%s, progress=%s, error=%s, cancel_requested=%s, 
                    pdf_scan_done=%s, logs=%s
                WHERE job_id=%s
            """, (
                job.status, 
                progress_json, 
                job.error, 
                cancel_requested, 
                pdf_scan_done, 
                logs_json, 
                job.job_id
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
        logger.error(f"DB UPDATE 실패 (job_id={job.job_id}): {e}", exc_info=True)
    # ==========================================
    
    return job.progress


def update_job_progress_from_files(job_id: str) -> None:
    """
    storedfile 상태 변경 시 job.progress 업데이트
    분류 탭에서 progress 대신 storedfile 상태를 기반으로 진행률을 표시하기 위해 사용
    """
    job = JOBS.get(job_id)
    if not job or job.kind != "pdf_upload":
        return
    
    _sync_pdf_progress(job)
    # ✅ 성능 최적화: 디바운싱된 manifest 저장 사용
    from .runtime_persistence import persist_runtime_manifests_debounced
    persist_runtime_manifests_debounced()


def recover_expired_page_leases() -> int:
    job_pages_repo.init_job_pages_table()
    return job_pages_repo.recover_expired_processing_pages()


def run_pdf_job(job: Job) -> None:
    if fitz is None:
        job.status = "error"
        job.error = "PyMuPDF(fitz)가 없어 PDF 페이지 단위 처리를 할 수 없습니다. `pip install pymupdf` 후 재시도하세요."
        return
    if not job.pdf_path:
        job.status = "error"
        job.error = "pdf_path missing"
        return

    if job.status != "paused":
        job.status = "processing"
    job.error = None
    add_job_log(job, "info", "doc_filter", "PDF 선별/처리를 시작합니다.")
    job_pages_repo.init_job_pages_table()

    pdf_path = Path(job.pdf_path)
    if not pdf_path.exists():
        job.status = "error"
        job.error = "PDF 파일이 없습니다."
        add_job_log(job, "error", "fail", "PDF 파일이 존재하지 않습니다.")
        return

    try:
        doc = fitz.open(str(pdf_path))
    except Exception as exc:
        job.status = "error"
        formatted = format_exception_for_log(exc)
        job.error = f"PDF 열기 실패: {formatted}"
        add_job_log(job, "error", "fail", f"PDF 열기 실패: {formatted}")
        return

    total_pages = job_pages_repo.job_pages_total(job.job_id) or int(getattr(doc, "page_count", 0) or 0)
    _sync_pdf_progress(job)
    add_job_log(job, "info", "doc_filter", f"총 {total_pages}페이지 스캔 예정")

    stem = Path(job.pdf_name or pdf_path.name).stem
    workers = max(1, int(getattr(config, "PDF_OCR_WORKERS", 4) or 4))
    any_error = False
    file_ids_lock = threading.Lock()

    def _run_ocr_stage(page_index: int, page_no: int, out_name: str, stored_file_id: str) -> bool:
        nonlocal any_error
        
        # 시작 전 취소 체크
        if job.cancel_requested:
            with state.STATE_LOCK:
                stored_file = FILES.get(stored_file_id)
                if stored_file:
                    stored_file.status = "cancelled"
            persist_runtime_manifests()
            return False
        
        try:
            # 여기서 status를 processing으로 변경 (실제 OCR 처리 시작 시점)
            with state.STATE_LOCK:
                stored_file = FILES.get(stored_file_id)
                if stored_file:
                    stored_file.status = "processing"
                    stored_file.error = None
            
            persist_runtime_manifests()
            
            add_job_log(job, "info", "ocr", f"OCR 처리 중: {out_name}")
            process_file(stored_file_id)
            
            with state.STATE_LOCK:
                result_file = FILES.get(stored_file_id)
                if result_file and result_file.status == "error":
                    raise RuntimeError(result_file.error or f"OCR 실패: {out_name}")

            with file_ids_lock:
                if stored_file_id not in job.file_ids:
                    job.file_ids.append(stored_file_id)

            # OCR 완료 시 rotation 정보도 함께 저장
            with state.STATE_LOCK:
                stored_file = FILES.get(stored_file_id)
                rotation_to_save = stored_file.rotation if stored_file else None
            
            job_pages_repo.mark_page_done(job.job_id, page_index, True, file_id=stored_file_id, rotation=rotation_to_save)
            add_job_log(job, "success", "ocr", f"OCR 완료: {out_name}")
            return True
        except Exception as exc:
            any_error = True
            reason = classify_exception(exc)
            
            # 중요: StoredFile 객체는 유지하되 status만 error로 변경
            with state.STATE_LOCK:
                stored_file = FILES.get(stored_file_id)
                if stored_file:
                    stored_file.status = "error"
                    stored_file.error = format_exception_for_log(exc)
            
            persist_runtime_manifests()
            
            next_status = job_pages_repo.fail_page(
                job.job_id,
                page_index,
                format_exception_for_log(exc),
                max_attempts=PAGE_MAX_ATTEMPTS,
            )
            if next_status == "error":
                add_job_log(job, "error", "page", _page_retry_log_message(page_no, reason, exc, final=True))
            else:
                add_job_log(job, "warn", "page", _page_retry_log_message(page_no, reason, exc, final=False))
            return False
        finally:
            _sync_pdf_progress(job)

    try:
        add_job_log(job, "info", "ocr", f"OCR 워커 {workers}개로 병렬 처리합니다.")
        futures: Dict[Future, int] = {}
        with ThreadPoolExecutor(max_workers=workers) as executor:
            while True:
                if _wait_if_paused(job):
                    job.status = "processing"
                if job.cancel_requested:
                    # 제출된 모든 Future 취소 시도
                    cancelled_futures = []
                    for fut in list(futures.keys()):
                        if fut.cancel():  # 취소 성공 (아직 실행 안된 작업)
                            cancelled_futures.append(fut)
                    
                    # 취소된 작업들의 file_id 찾아서 상태 변경
                    for fut in cancelled_futures:
                        page_no = futures.get(fut)
                        if page_no:
                            page_index = int(page_no) - 1
                            # 해당 페이지의 StoredFile 찾기
                            with state.STATE_LOCK:
                                for fid, f in FILES.items():
                                    if (getattr(f, "job_id", None) == job.job_id and 
                                        int(getattr(f, "page_no", -1)) == int(page_no)):
                                        f.status = "cancelled"
                            persist_runtime_manifests()
                            # job_pages_repo의 페이지 상태도 cancelled로 변경
                            job_pages_repo.cancel_page(job.job_id, page_index)
                    
                    # 아직 큐에 남아있는 queued 상태의 파일들도 cancelled로 변경
                    with state.STATE_LOCK:
                        for fid, f in FILES.items():
                            if (getattr(f, "job_id", None) == job.job_id and 
                                f.status == "queued"):
                                f.status = "cancelled"
                                persist_runtime_manifests()
                                # 해당 페이지의 job_pages_repo 상태도 cancelled로 변경
                                if getattr(f, "page_no", None) is not None:
                                    page_index = int(f.page_no) - 1
                                    job_pages_repo.cancel_page(job.job_id, page_index)
                    
                    add_job_log(job, "info", "cancel", 
                              f"취소 완료: {len(cancelled_futures)}개 작업 취소됨")
                    break

                claimed = job_pages_repo.claim_next_page(job.job_id, lease_seconds=PAGE_LEASE_SECONDS)
                if not claimed:
                    break

                page_index = int(claimed["page_index"])
                page_no = page_index + 1

                try:
                    if page_index == 0 or page_no % 10 == 0 or page_no == total_pages:
                        add_job_log(job, "info", "doc_filter", f"페이지 스캔 진행: {page_no}/{total_pages}")

                    existing_file = find_file_by_source(job.job_id, page_no)
                    if existing_file and existing_file.status == "done":
                        with file_ids_lock:
                            if existing_file.file_id not in job.file_ids:
                                job.file_ids.append(existing_file.file_id)
                        job_pages_repo.mark_page_done(job.job_id, page_index, True, file_id=existing_file.file_id)
                        add_job_log(job, "info", "retry", f"기존 성공 결과 재사용: 페이지 {page_no}")
                        _sync_pdf_progress(job)
                        continue

                    png_bytes = _render_pdf_page_to_png_bytes(doc, page_index=page_index, dpi=int(job.pdf_dpi or 300))
                    pred = call_doc_filter_image(png_bytes, f"{stem}_{page_no:04d}.png")
                    is_interest = bool(pred.get("is_interest"))

                    # 모든 페이지 이미지 저장 (관심문서 여부와 상관없이)
                    out_name = f"{stem}_{page_no:04d}.png"
                    out_path = config.DERIVED_DIR / f"{uuid.uuid4().hex}_{out_name}"
                    out_path.write_bytes(png_bytes)

                    auto_rot = maybe_rotation_from_doc_index(
                        int(pred.get("doc_index", -1)) if pred.get("doc_index") is not None else None
                    )
                    rot_to_use = job.pdf_rotation if job.pdf_rotation else auto_rot

                    stored_file = create_stored_file(
                        "pdf_page",
                        original_name=out_name,
                        stored_path=out_path,
                        rotation=rot_to_use,
                        job_id=job.job_id,
                        page_no=page_no,
                        is_interest=is_interest,  # 관심문서 여부 표시
                    )

                    if not is_interest:
                        # 비관심문서: 이미지는 저장하지만 OCR은 하지 않음
                        stored_file.status = "done"  # ← status를 done으로 변경
                        
                        # ========== DB UPDATE 추가 ==========
                        try:
                            from core import ocr_db
                            from ..repositories import db_repo
                            
                            cfg = db_repo.load_cfg()
                            conn = ocr_db.connect(cfg)
                            
                            try:
                                cursor = conn.cursor()
                                
                                # result JSON 변환 (비관심문서는 빈 결과)
                                result_json = json.dumps(stored_file.result or {}, ensure_ascii=False)
                                stage_stats_json = json.dumps(stored_file.stage_stats or {}, ensure_ascii=False)
                                
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
                        
                        persist_runtime_manifests()  # ← 매니페스트 저장
                        
                        # rotation 정보도 함께 저장
                        job_pages_repo.update_page_rotation(job.job_id, page_index, rot_to_use)
                        
                        job_pages_repo.mark_page_done(
                            job.job_id, 
                            page_index, 
                            False, 
                            file_id=stored_file.file_id,
                        )
                        _sync_pdf_progress(job)
                        continue

                    # 관심문서: OCR 처리 수행
                    job_pages_repo.mark_page_interest(job.job_id, page_index, file_id=stored_file.file_id)
                    # 관심문서도 DB에 rotation 저장 (정합성 확보)
                    job_pages_repo.update_page_rotation(job.job_id, page_index, rot_to_use)
                    add_job_log(job, "info", "doc_filter", f"페이지 {page_no} 관심문서 → OCR 큐 등록")
                    fut = executor.submit(
                        _run_ocr_stage,
                        page_index,
                        page_no,
                        out_name,
                        stored_file.file_id,
                    )
                    futures[fut] = page_no

                    # doc_filter 스캔 루프는 OCR 워커 포화 여부와 독립적으로 계속 진행한다.
                    # (이전에는 futures 개수 임계치에서 wait 하며 스캔이 멈췄다)
                    if len(futures) and len(futures) % max(1, workers * 10) == 0:
                        add_job_log(job, "info", "ocr", f"OCR 비동기 처리 중: 누적 대기/진행 {len(futures)}건")
                except Exception as exc:
                    any_error = True
                    reason = classify_exception(exc)
                    next_status = job_pages_repo.fail_page(
                        job.job_id,
                        page_index,
                        format_exception_for_log(exc),
                        max_attempts=PAGE_MAX_ATTEMPTS,
                    )
                    if next_status == "error":
                        add_job_log(job, "error", "page", f"페이지 {page_no} 최종 실패 (원인={reason}): {exc}")
                    else:
                        add_job_log(job, "warn", "page", f"페이지 {page_no} 재시도 예정 (원인={reason}): {exc}")
                    _sync_pdf_progress(job)

            if futures:
                done, _ = wait(set(futures.keys()))
                for finished in done:
                    futures.pop(finished, None)
                    finished.result()

        job.pdf_scan_done = True

        # 작업 완료 전 최종 상태 동기화
        _sync_pdf_progress(job)
        final_error_count = int(job.progress.get("error", 0) or 0)
        final_done_count = int(job.progress.get("done", 0) or 0)
        final_total_count = int(job.progress.get("total", 0) or 0)
        
        # StoredFile 중 error 상태인 파일도 카운트 (관심문서 OCR 실패 등)
        with state.STATE_LOCK:
            for fid in job.file_ids:
                stored = FILES.get(fid)
                if stored and stored.status == "error" and stored.is_interest:
                    final_error_count += 1

        if job.cancel_requested:
            job.status = "cancelled"
            job.error = "사용자가 작업을 중지했습니다."
            add_job_log(job, "warn", "cancel", "사용자 요청으로 작업이 중지되었습니다.")
        elif final_done_count + final_error_count == final_total_count:
            # 모든 페이지 처리 완료 (성공 + 실패)
            if final_error_count > 0:
                job.status = "error"
                job.error = f"{final_error_count}개 페이지 처리 실패 (완료: {final_done_count}/{final_total_count})"
                add_job_log(job, "error", "complete", f"PDF 작업 종료: {final_error_count}개 페이지 처리 실패 (완료: {final_done_count}/{final_total_count})")
            else:
                job.status = "done"
                add_job_log(job, "success", "complete", f"PDF 작업 완료: {final_done_count}/{final_total_count}페이지")
        else:
            job.status = "processing"
            add_job_log(job, "info", "progress", f"PDF 작업 진행 중: {final_done_count}/{final_total_count}페이지 완료")
    finally:
        try:
            doc.close()
        except Exception:
            pass


def run_job(job_id: str) -> None:
    job = JOBS[job_id]
    
    # 분류 탭 작업인지 확인 (로그 메시지로 구분)
    is_classification_job = False
    for log in job.logs:
        if "분류 탭" in log.get("message", ""):
            is_classification_job = True
            break
    
    if is_classification_job:
        # 분류 탭 작업: 업로드만 수행
        run_pdf_upload_only_job(job)
    elif job.kind == "pdf_upload":
        # 일반 PDF 작업: 분류 + OCR 수행
        run_pdf_job(job)
    else:
        # 이미지 작업
        run_files_job(job)


def run_pdf_upload_only_job(job: Job) -> None:
    """
    분류 탭 전용: PDF 업로드만 수행하고 자동 분류/OCR을 하지 않음
    모든 페이지를 비관심으로 설정하고 사용자가 직접 분류하도록 함
    """
    if fitz is None:
        job.status = "error"
        job.error = "PyMuPDF(fitz)가 없어 PDF 페이지 단위 처리를 할 수 없습니다. `pip install pymupdf` 후 재시도하세요."
        return
    if not job.pdf_path:
        job.status = "error"
        job.error = "pdf_path missing"
        return

    if job.status != "paused":
        job.status = "processing"
    job.error = None
    add_job_log(job, "info", "upload", "PDF 업로드 전용 작업을 시작합니다. (자동 분류 없음)")
    job_pages_repo.init_job_pages_table()

    pdf_path = Path(job.pdf_path)
    if not pdf_path.exists():
        job.status = "error"
        job.error = "PDF 파일이 없습니다."
        add_job_log(job, "error", "fail", "PDF 파일이 존재하지 않습니다.")
        return

    try:
        doc = fitz.open(str(pdf_path))
    except Exception as exc:
        job.status = "error"
        formatted = format_exception_for_log(exc)
        job.error = f"PDF 열기 실패: {formatted}"
        add_job_log(job, "error", "fail", f"PDF 열기 실패: {formatted}")
        return

    total_pages = job_pages_repo.job_pages_total(job.job_id) or int(getattr(doc, "page_count", 0) or 0)
    _sync_pdf_progress(job)
    add_job_log(job, "info", "upload", f"총 {total_pages}페이지 업로드 예정")

    stem = Path(job.pdf_name or pdf_path.name).stem
    any_error = False
    workers = 1  # 1워커 순차 처리 (경합 방지)
    file_ids_lock = threading.Lock()

    def _process_page(page_index: int, page_no: int) -> bool:
        """단일 페이지 처리 함수"""
        try:
            # 페이지 이미지 렌더링
            png_bytes = _render_pdf_page_to_png_bytes(doc, page_index=page_index, dpi=int(job.pdf_dpi or 300))
            
            # 이미지 저장
            out_name = f"{stem}_{page_no:04d}.png"
            out_path = config.DERIVED_DIR / f"{uuid.uuid4().hex}_{out_name}"
            out_path.write_bytes(png_bytes)

            # 자동 분류 및 회전 감지 제거 - 모든 페이지를 비관심으로 설정
            rot_to_use = job.pdf_rotation if job.pdf_rotation else None

            stored_file = create_stored_file(
                "pdf_page",
                original_name=out_name,
                stored_path=out_path,
                rotation=rot_to_use,
                job_id=job.job_id,
                page_no=page_no,
                is_interest=False,  # 모든 페이지를 비관심으로 설정 (사용자가 직접 분류)
            )

            # 모든 페이지를 비관심으로 처리 (OCR 수행 안 함)
            stored_file.status = "done"
            
            # ========== DB UPDATE 추가 ==========
            try:
                from core import ocr_db
                from ..repositories import db_repo
                
                cfg = db_repo.load_cfg()
                conn = ocr_db.connect(cfg)
                
                try:
                    cursor = conn.cursor()
                    
                    # result JSON 변환 (비관심문서는 빈 결과)
                    result_json = json.dumps(stored_file.result or {}, ensure_ascii=False)
                    stage_stats_json = json.dumps(stored_file.stage_stats or {}, ensure_ascii=False)
                    
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
            
            # rotation 정보 저장 (사용자가 직접 변경 가능)
            if rot_to_use:
                job_pages_repo.update_page_rotation(job.job_id, page_index, rot_to_use)
            
            job_pages_repo.mark_page_done(
                job.job_id, 
                page_index, 
                False, 
                file_id=stored_file.file_id,
            )
            
            # job.file_ids에 추가 (thread-safe)
            with file_ids_lock:
                if stored_file.file_id not in job.file_ids:
                    job.file_ids.append(stored_file.file_id)
            
            return True
        except Exception as exc:
            reason = classify_exception(exc)
            next_status = job_pages_repo.fail_page(
                job.job_id,
                page_index,
                format_exception_for_log(exc),
                max_attempts=PAGE_MAX_ATTEMPTS,
            )
            if next_status == "error":
                add_job_log(job, "error", "page", f"페이지 {page_no} 업로드 실패 (원인={reason}): {exc}")
            else:
                add_job_log(job, "warn", "page", f"페이지 {page_no} 업로드 재시도 예정 (원인={reason}): {exc}")
            return False
        finally:
            _sync_pdf_progress(job)

    try:
        add_job_log(job, "info", "upload", f"업로드 워커 {workers}개로 병렬 처리합니다.")
        futures: Dict[Future, int] = {}
        with ThreadPoolExecutor(max_workers=workers) as executor:
            for page_index in range(total_pages):
                if _wait_if_paused(job):
                    job.status = "processing"
                if job.cancel_requested:
                    # 제출된 모든 Future 취소 시도
                    for fut in list(futures.keys()):
                        fut.cancel()
                    job.status = "cancelled"
                    job.error = "사용자가 작업을 중지했습니다."
                    add_job_log(job, "warn", "cancel", "사용자 요청으로 작업이 중지되었습니다.")
                    break

                page_no = page_index + 1

                if page_index == 0 or page_no % 10 == 0 or page_no == total_pages:
                    add_job_log(job, "info", "upload", f"페이지 업로드 진행: {page_no}/{total_pages}")

                # 병렬 처리를 위해 Future 제출
                fut = executor.submit(_process_page, page_index, page_no)
                futures[fut] = page_no

            # 모든 작업 완료 대기
            for fut in list(futures.keys()):
                try:
                    fut.result()
                except Exception as exc:
                    page_no = futures.get(fut, 0)
                    add_job_log(job, "error", "page", f"페이지 {page_no} 처리 중 예외 발생: {exc}")
                    any_error = True
                finally:
                    futures.pop(fut, None)

        # 작업 완료 후 file_ids를 페이지 번호 순서대로 정렬
        if job.file_ids:
            # 미리 모든 page_no 수집 (Race Condition 방지)
            page_nos = {}
            with state.STATE_LOCK:
                for fid in job.file_ids:
                    stored = FILES.get(fid)
                    if stored:
                        page_nos[fid] = int(getattr(stored, "page_no", 0) or 0)
            
            # 수집된 데이터로 정렬
            job.file_ids.sort(key=lambda fid: page_nos.get(fid, 0))
            add_job_log(job, "info", "upload", f"file_ids를 페이지 번호 순서대로 정렬 완료")

        # 작업 완료 전 최종 상태 동기화
        _sync_pdf_progress(job)
        final_error_count = int(job.progress.get("error", 0) or 0)
        final_done_count = int(job.progress.get("done", 0) or 0)
        final_total_count = int(job.progress.get("total", 0) or 0)

        if job.cancel_requested:
            job.status = "cancelled"
            job.error = "사용자가 작업을 중지했습니다."
            add_job_log(job, "warn", "cancel", "사용자 요청으로 작업이 중지되었습니다.")
        elif final_error_count > 0:
            job.status = "error"
            job.error = f"{final_error_count}개 페이지 업로드 실패 (완료: {final_done_count}/{final_total_count})"
            add_job_log(job, "error", "complete", f"PDF 업로드 종료: {final_error_count}개 페이지 업로드 실패 (완료: {final_done_count}/{final_total_count})")
        elif final_done_count == final_total_count:
            job.status = "done"
            add_job_log(job, "success", "complete", f"PDF 업로드 완료: {final_done_count}/{final_total_count}페이지 (사용자가 직접 분류 필요)")
        else:
            job.status = "processing"
            add_job_log(job, "info", "progress", f"PDF 업로드 진행 중: {final_done_count}/{final_total_count}페이지 완료")
    finally:
        try:
            doc.close()
        except Exception:
            pass


def start_job_thread(job_id: str) -> None:
    """
    작업을 큐에 추가하고 순차적으로 실행
    PDF 내의 이미지는 병렬로 처리되지만, PDF 작업 자체는 순차적으로 하나씩만 실행
    """
    from .. import state
    
    with state.ACTIVE_JOB_LOCK:
        if state.ACTIVE_JOB_ID is not None:
            # 이미 활성 작업이 있으면 큐에 추가
            state.JOB_QUEUE.append(job_id)
            job = JOBS.get(job_id)
            if job:
                queue_position = len(state.JOB_QUEUE)
                add_job_log(job, "info", "queue", 
                          f"작업이 대기열에 추가됨 (대기 순서: {queue_position})")
            return
        
        # 활성 작업이 없으면 바로 시작
        state.ACTIVE_JOB_ID = job_id
    
    t = threading.Thread(target=run_job_with_cleanup, args=(job_id,), daemon=True)
    t.start()


def run_job_with_cleanup(job_id: str) -> None:
    """
    작업 실행 후 큐 정리 및 다음 작업 시작
    """
    from .. import state
    
    try:
        run_job(job_id)
    finally:
        with state.ACTIVE_JOB_LOCK:
            # 현재 작업 완료
            state.ACTIVE_JOB_ID = None
            
            # 대기열에서 다음 작업 가져오기
            if state.JOB_QUEUE:
                next_job_id = state.JOB_QUEUE.pop(0)
                state.ACTIVE_JOB_ID = next_job_id
                
                # 다음 작업 시작
                next_job = JOBS.get(next_job_id)
                if next_job:
                    add_job_log(next_job, "info", "queue", 
                              f"대기열에서 작업 시작 (남은 대기: {len(state.JOB_QUEUE)})")
                
                next_thread = threading.Thread(target=run_job_with_cleanup, args=(next_job_id,), daemon=True)
                next_thread.start()
