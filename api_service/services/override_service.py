from __future__ import annotations

import json
import threading
import time
from dataclasses import asdict
from typing import Any, Callable, Dict, Optional
from queue import Queue

from .. import config
from ..errors import JobPageStateError, OverrideValidationError
from ..models import Job, StoredFile
from ..repositories import job_pages_repo
from ..utils import format_exception_for_log
from .files_service import make_empty_result, process_file
from .pipeline_debug_service import build_stage, derive_failed_stage
from .runtime_persistence import persist_runtime_manifests, persist_runtime_manifests_debounced

LogFn = Optional[Callable[[str, str, str], None]]

# ==================== 대기열 시스템 ====================
# 최대 동시 OCR 처리 수
MAX_CONCURRENT_OCR_REQUESTS = 4

# 대기열 및 활성 요청 관리
_ocr_queue = Queue()
_active_ocr_requests = 0
_active_ocr_requests_lock = threading.Lock()

def _process_ocr_queue():
    """대기열에서 OCR 요청을 처리하는 워커 함수"""
    global _active_ocr_requests
    
    while True:
        # 대기열에서 작업 가져오기
        task = _ocr_queue.get()
        if task is None:  # 종료 신호
            break
        
        worker_fn, page_index, job = task
        
        try:
            # ✅ 중요: 활성 요청 수 증가와 상태 변경을 원자적으로 처리
            with _active_ocr_requests_lock:
                _active_ocr_requests += 1
                # ✅ 중요: 상태를 processing으로 변경한 후에야 OCR 처리 시작
                # 이렇게 해야 SSE 이벤트가 정확한 상태를 전송
                if page_index is not None and job is not None:
                    job_pages_repo.update_page_status(job.job_id, page_index, "processing")
            
            # OCR 처리 실행
            worker_fn()
            
            # 완료 후 상태 업데이트
            if page_index is not None and job is not None:
                stored_file = FILES.get(worker_fn.__self__.file_id) if hasattr(worker_fn, '__self__') else None
                if stored_file and stored_file.status == "done":
                    job_pages_repo.mark_page_done(job.job_id, page_index, True, file_id=stored_file.file_id)
                elif stored_file:
                    job_pages_repo.fail_page(job.job_id, page_index, stored_file.error or "manual reprocess failed", max_attempts=1)
        except Exception as exc:
            # 에러 처리
            if page_index is not None and job is not None:
                job_pages_repo.fail_page(job.job_id, page_index, str(exc), max_attempts=1)
        finally:
            # 활성 요청 수 감소
            with _active_ocr_requests_lock:
                _active_ocr_requests -= 1
            
            # 대기열 작업 완료 표시
            _ocr_queue.task_done()

# 대기열 처리 워커 스레드들 시작 (최대 4개 동시 처리)
_queue_worker_threads = []
for i in range(MAX_CONCURRENT_OCR_REQUESTS):
    worker_thread = threading.Thread(target=_process_ocr_queue, daemon=True, name=f"ocr_queue_worker_{i}")
    worker_thread.start()
    _queue_worker_threads.append(worker_thread)


def _manual_non_interest_result(stored_file: StoredFile) -> Dict[str, Any]:
    stages = {
        "doc_filter": build_stage("manual_override", 0),
        "yolo": build_stage("skipped", 0),
        "ocr": build_stage("skipped", 0),
        "override": build_stage("ok", 0, extra={"is_interest": False, "rotation": stored_file.rotation}),
    }
    debug = {
        "pipeline_started_ms": int(time.time() * 1000),
        "rotation": stored_file.rotation,
        "is_interest": False,
        "decision": "manual_non_interest",
        "stages": stages,
        "pipeline_elapsed_ms": 0,
        "fallback_used": False,
        "failed_stage": derive_failed_stage(stages),
        "error_code": None,
        "retryable": False,
    }
    return make_empty_result(stored_file, debug=debug)


def apply_file_override(
    stored_file: StoredFile,
    *,
    is_interest_raw: Any,
    rotation_raw: Any,
    reprocess: bool,
    job: Optional[Job] = None,
    page_index: Optional[int] = None,
    log_fn: LogFn = None,
) -> Dict[str, Any]:
    if is_interest_raw is None and rotation_raw is None:
        raise OverrideValidationError("at least one of is_interest/rotation must be provided")

    if rotation_raw is not None and rotation_raw not in ("cw", "ccw", "180", "", None):
        raise OverrideValidationError("rotation must be one of: cw, ccw, 180")

    if rotation_raw is not None:
        stored_file.rotation = rotation_raw or None
    if is_interest_raw is not None:
        stored_file.is_interest = bool(is_interest_raw)

    stored_file.stage_stats = dict(stored_file.stage_stats or {})
    stored_file.stage_stats["override"] = {
        "status": "ok",
        "elapsed_ms": 0,
        "updated_ms": int(time.time() * 1000),
        "is_interest": stored_file.is_interest,
        "rotation": stored_file.rotation,
    }

    if page_index is not None and job is not None:
        try:
            job_pages_repo.set_page_interest(job.job_id, page_index, is_interest=bool(stored_file.is_interest), file_id=stored_file.file_id)
        except Exception as exc:
            raise JobPageStateError("failed to update page interest state", detail=str(exc))

    if not reprocess:
        persist_runtime_manifests_debounced()
        if log_fn:
            log_fn("info", "override", "분류/회전값만 업데이트")
        return {"ok": True, "file": asdict(stored_file), "reprocess": False}

    if stored_file.is_interest is False:
        stored_file.status = "done"
        stored_file.error = None
        stored_file.result = _manual_non_interest_result(stored_file)
        try:
            (config.RESULTS_DIR / f"{stored_file.file_id}.json").write_text(
                json.dumps(stored_file.result, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass
        if page_index is not None and job is not None:
            try:
                job_pages_repo.mark_page_done(job.job_id, page_index, False, file_id=stored_file.file_id)
            except Exception as exc:
                raise JobPageStateError("failed to mark page done", detail=str(exc))
        persist_runtime_manifests_debounced()
        if log_fn:
            log_fn("info", "override", "비관심으로 전환 후 결과를 보존했습니다")
        return {"ok": True, "file": asdict(stored_file), "reprocess": True}

    stored_file.status = "queued"
    stored_file.error = None
    stored_file.result = None
    persist_runtime_manifests_debounced()

    def _worker() -> None:
        try:
            stored_file.status = "processing"
            persist_runtime_manifests_debounced()
            process_file(stored_file.file_id)
        except Exception as exc:
            stored_file.status = "error"
            stored_file.error = format_exception_for_log(exc)
            persist_runtime_manifests_debounced()
            raise

    # 대기열에 작업 추가 (최대 4개 동시 처리 제한)
    _ocr_queue.put((_worker, page_index, job))
    
    if log_fn:
        with _active_ocr_requests_lock:
            queue_size = _ocr_queue.qsize()
            active_count = _active_ocr_requests
        log_fn("info", "override", f"재처리를 큐에 등록했습니다 (대기열: {queue_size}, 활성: {active_count}/{MAX_CONCURRENT_OCR_REQUESTS})")
    
    return {"ok": True, "file": asdict(stored_file), "reprocess": True}
