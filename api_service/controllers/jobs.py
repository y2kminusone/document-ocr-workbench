from __future__ import annotations

import uuid
from pathlib import Path
import asyncio
import json
import time
import threading
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, Request
from fastapi.responses import StreamingResponse

try:
    import fitz  # type: ignore
except Exception:
    fitz = None

from .. import config
from ..models import Job, OverrideResponse, PageOverrideRequest
from ..services.files_service import create_stored_file
from ..services.override_service import apply_file_override
from ..services.job_view_service import file_summary, job_files_with_virtual
from ..services.jobs_service import start_job_thread, add_job_log, prepare_files_retry, update_job_progress_from_files
from ..services.runtime_persistence import persist_runtime_manifests, persist_runtime_manifests_debounced
from ..repositories import job_pages_repo
from .. import state
from ..state import FILES, JOBS
from ..utils import ensure_dirs, safe_name, save_upload_to
from ..utils import maybe_rotation_from_doc_index
from ..clients import call_doc_filter_image
from ..errors import NotFoundAppError, OverrideValidationError, VirtualPageMaterializationError

router = APIRouter()

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def _job_summary(job: Job, include_logs: bool = False) -> Dict[str, Any]:
    data = {
        "job_id": job.job_id,
        "kind": job.kind,
        "created_ms": job.created_ms,
        "status": job.status,
        "progress": job.progress,
        "error": job.error,
        "name": job.name,
        **_job_ops(job),
    }
    if include_logs:
        data["logs"] = job.logs[-120:] if isinstance(job.logs, list) else []
    return data


def _job_ops(job: Job) -> Dict[str, Any]:
    progress = job.progress if isinstance(job.progress, dict) else {}
    total = int(progress.get("total", 0) or 0)
    done = int(progress.get("done", 0) or 0)
    error = int(progress.get("error", 0) or 0)
    return {
        "paused": job.status == "paused",
        "cancel_requested": bool(job.cancel_requested),
        "remaining": int(progress.get("remaining", max(0, total - done - error)) or 0),
        "retrying": int(progress.get("retrying", 0) or 0),
    }





@router.get("/api/jobs")
async def list_jobs():
    items = sorted(JOBS.values(), key=lambda j: j.created_ms, reverse=True)
    return {"jobs": [_job_summary(j, include_logs=False) for j in items]}


@router.get("/api/jobs/events")
@router.get("/jobs/events")
async def job_events(request: Request):
    async def event_stream():
        last_payload: Optional[str] = None
        last_pages_hash: Optional[str] = None
        idle_ticks = 0
        ping_interval = 6  # 3초 단위로 ping 전송 (0.5초 * 6 = 3초)
        while True:
            if await request.is_disconnected():
                break
            items = sorted(JOBS.values(), key=lambda j: j.created_ms, reverse=True)
            payload = {"jobs": [_job_summary(j, include_logs=False) for j in items]}
            data = json.dumps(payload, ensure_ascii=False, sort_keys=True)
            
            # ✅ 성능 최적화: 페이지 상태 확인 주석 처리 (무거운 DB 조회 방지)
            # 페이지 상태 변경 감지를 위한 해시 계산
            # pages_hash = None
            # for job in items:
            #     if job.kind == "pdf_upload":
            #         try:
            #             pages = job_pages_repo.list_job_pages(job.job_id)
            #             # 페이지 상태만 포함하여 해시 계산 (is_interest, status, file_id)
            #             pages_data = [(p.get("page_index"), p.get("is_interest"), p.get("status"), p.get("file_id")) for p in pages]
            #             pages_hash = hash(str(pages_data))
            #             break  # 첫 번째 PDF 작업만 확인 (성능 최적화)
            #         except Exception:
            #             pass
            
            # 작업 상태가 변경된 경우 이벤트 전송 (페이지 상태 확인 제거)
            if data != last_payload:
                last_payload = data
                idle_ticks = 0
                yield f"event: jobs\ndata: {data}\n\n"
            else:
                idle_ticks += 1
                # 3초 단위로 ping 전송 (fallback 메커니즘)
                if idle_ticks >= ping_interval:
                    idle_ticks = 0
                    ping = json.dumps({"ts": int(time.time() * 1000), "type": "keepalive"})
                    yield f"event: ping\ndata: {ping}\n\n"
            await asyncio.sleep(0.5)

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise NotFoundAppError("JOB_NOT_FOUND", "job not found")
    files = job_files_with_virtual(job)
    return {"job": _job_summary(job, include_logs=False), "files": files}


@router.get("/api/jobs/{job_id}/events")
@router.get("/jobs/{job_id}/events")
async def job_detail_events(job_id: str, request: Request):
    async def event_stream():
        last_payload: Optional[str] = None
        last_job_state: Optional[Dict[str, Any]] = None
        last_files_hash: Optional[str] = None
        idle_ticks = 0
        ping_interval = 6  # 3초 단위로 ping 전송 (0.5초 * 6 = 3초)
        
        while True:
            if await request.is_disconnected():
                break
            job = JOBS.get(job_id)
            if not job:
                data = json.dumps({"error": "job not found"}, ensure_ascii=False)
                yield f"event: error\ndata: {data}\n\n"
                break
            
            # ✅ 성능 최적화: 이벤트 필터링 - 실제 변경이 있을 때만 데이터 생성
            job_changed = False
            files_changed = False
            
            # 작업 상태 변경 확인
            current_job_state = {
                "status": job.status,
                "progress": job.progress,
                "error": job.error,
                "cancel_requested": job.cancel_requested,
                "created_ms": job.created_ms
            }
            
            if last_job_state != current_job_state:
                job_changed = True
                last_job_state = current_job_state
            
            # 파일 상태 변경 확인 (빠른 해시 계산)
            current_files = job_files_with_virtual(job)
            
            # 파일 해시 계산 (상태가 변경된 파일만 확인)
            if last_files_hash is None:
                # 첫 요청: 전체 해시 계산
                files_changed = True
                files_hash_data = "".join([
                    f"{f.get('file_id')}:{f.get('status')}:{f.get('error')}"
                    for f in current_files
                ])
                last_files_hash = hash(files_hash_data)
            else:
                # 이후 요청: 변경된 파일만 확인
                files_hash_data = "".join([
                    f"{f.get('file_id')}:{f.get('status')}:{f.get('error')}"
                    for f in current_files
                ])
                current_files_hash = hash(files_hash_data)
                
                if current_files_hash != last_files_hash:
                    files_changed = True
                    last_files_hash = current_files_hash
            
            # 변경이 있을 때만 전체 페이로드 생성 및 전송
            if job_changed or files_changed:
                payload = {
                    "job": _job_summary(job, include_logs=False),
                    "files": current_files,
                }
                data = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
                
                if data != last_payload:
                    last_payload = data
                    idle_ticks = 0
                    yield f"event: job\ndata: {data}\n\n"
            else:
                idle_ticks += 1
                # 3초 단위로 ping 전송 (fallback 메커니즘)
                if idle_ticks >= ping_interval:
                    idle_ticks = 0
                    ping = json.dumps({"ts": int(time.time() * 1000), "type": "keepalive"})
                    yield f"event: ping\ndata: {ping}\n\n"
            
            await asyncio.sleep(0.5)

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.get("/api/system/logs")
async def list_system_logs(limit: int = 300):
    lim = max(1, min(int(limit or 300), 1000))
    logs = state.SYSTEM_LOGS[-lim:] if isinstance(state.SYSTEM_LOGS, list) else []
    return {"logs": logs}


@router.get("/api/system/logs/events")
async def system_log_events(request: Request):
    async def event_stream():
        last_seq = 0
        idle_ticks = 0
        ping_interval = 12  # 3초 단위로 ping 전송 (0.25초 * 12 = 3초)
        logs = state.SYSTEM_LOGS if isinstance(state.SYSTEM_LOGS, list) else []
        if logs:
            try:
                last_seq = int(logs[-1].get("seq", 0) or 0)
            except Exception:
                last_seq = 0
            data = json.dumps({"logs": logs[-200:]}, ensure_ascii=False)
            yield f"event: logs\ndata: {data}\n\n"

        while True:
            if await request.is_disconnected():
                break

            logs = state.SYSTEM_LOGS if isinstance(state.SYSTEM_LOGS, list) else []
            new_logs = []
            if logs:
                try:
                    new_logs = [l for l in logs if int(l.get("seq", 0) or 0) > int(last_seq)]
                except Exception:
                    new_logs = []
            if new_logs:
                try:
                    last_seq = int(new_logs[-1].get("seq", last_seq) or last_seq)
                except Exception:
                    pass
                data = json.dumps({"logs": new_logs}, ensure_ascii=False)
                idle_ticks = 0
                yield f"event: logs\ndata: {data}\n\n"
            else:
                idle_ticks += 1
                # 3초 단위로 ping 전송 (fallback 메커니즘)
                if idle_ticks >= ping_interval:
                    idle_ticks = 0
                    ping = json.dumps({"ts": int(time.time() * 1000), "type": "keepalive"})
                    yield f"event: ping\ndata: {ping}\n\n"
            await asyncio.sleep(0.25)

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise NotFoundAppError("JOB_NOT_FOUND", "job not found")
    job.cancel_requested = True
    add_job_log(job, "warn", "cancel", "사용자가 작업 취소를 요청했습니다. 현재까지 결과를 유지한 채 나중에 retry 할 수 있습니다.")
    if job.status in ("queued", "paused"):
        job.status = "cancelled"
        job.error = "사용자가 작업을 중지했습니다."
    persist_runtime_manifests()
    return {"job": _job_summary(job, include_logs=True)}


@router.post("/api/jobs/{job_id}/pause")
async def pause_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    if job.cancel_requested or job.status == "cancelled":
        raise HTTPException(status_code=409, detail="cancelled job cannot be resumed or paused")
    if job.status in ("done", "error"):
        raise HTTPException(status_code=409, detail=f"cannot pause a terminal job: {job.status}")

    if job.status != "paused":
        job.status = "paused"
        add_job_log(job, "info", "pause", "사용자가 작업 일시정지를 요청했습니다.")
    persist_runtime_manifests()
    return {"job": _job_summary(job, include_logs=True)}


@router.post("/api/jobs/{job_id}/resume")
async def resume_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    if job.cancel_requested or job.status == "cancelled":
        raise HTTPException(status_code=409, detail="cancelled job cannot be resumed")
    if job.status in ("done", "error"):
        raise HTTPException(status_code=409, detail=f"cannot resume a terminal job: {job.status}")

    if job.status == "paused":
        job.status = "processing"
        add_job_log(job, "info", "resume", "사용자가 작업 재개를 요청했습니다.")
    persist_runtime_manifests()
    return {"job": _job_summary(job, include_logs=True)}


@router.post("/api/jobs/{job_id}/retry")
async def retry_job(job_id: str, request: Request):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")

    try:
        body = await request.json()
    except Exception:
        body = {}

    scope = body.get("scope", "job")
    page_no = body.get("page_no")
    file_id = body.get("file_id")

    # scope=page: 특정 PDF 페이지 재시도
    if scope == "page":
        if job.kind != "pdf_upload":
            raise HTTPException(status_code=400, detail="page retry is only supported for pdf jobs")
        if not page_no or int(page_no or 0) <= 0:
            raise HTTPException(status_code=400, detail="invalid page number")

        page_index = int(page_no) - 1
        affected = job_pages_repo.requeue_page(job_id, page_index, reset_attempt=False)
        if affected <= 0:
            raise HTTPException(status_code=404, detail="page not found")

        linked = None
        for fid, f in FILES.items():
            if getattr(f, "job_id", None) == job_id and int(getattr(f, "page_no", -1) or -1) == int(page_no):
                linked = f
                f.status = "queued"
                f.error = None
                break

        job.error = None
        add_job_log(job, "info", "retry", f"사용자 요청으로 PDF {page_no}페이지 재처리를 시작합니다.")

        if job.status in ("done", "error", "cancelled"):
            job.cancel_requested = False
            job.status = "queued"
            start_job_thread(job_id)

        persist_runtime_manifests()
        return {
            "job": _job_summary(job, include_logs=True),
            "page_no": int(page_no),
            "linked_file_id": getattr(linked, "file_id", None),
        }

    # scope=file: 특정 파일 재시도
    if scope == "file":
        if not file_id:
            raise HTTPException(status_code=400, detail="file_id is required for file retry")

        stored = FILES.get(file_id)
        if not stored:
            raise HTTPException(status_code=404, detail="file not found")
        if file_id not in (job.file_ids or []):
            raise HTTPException(status_code=400, detail="file does not belong to this job")

        stored.status = "queued"
        stored.error = None
        job.error = None

        if job.kind == "pdf_upload" and getattr(stored, "page_no", None) is not None:
            page_index = max(0, int(stored.page_no) - 1)
            job_pages_repo.requeue_page(job_id, page_index, reset_attempt=False)
            add_job_log(job, "info", "retry", f"사용자 요청으로 페이지 {stored.page_no} 재처리를 시작합니다.")
        else:
            add_job_log(job, "info", "retry", f"사용자 요청으로 파일 재처리를 시작합니다: {stored.original_name}")

        if job.status in ("done", "error", "cancelled"):
            job.cancel_requested = False
            job.status = "queued"
            start_job_thread(job_id)

        persist_runtime_manifests()
        return {"job": _job_summary(job, include_logs=True), "file": file_summary(file_id)}

    # scope=job: 전체 재시도 (done 제외)
    if scope == "job":
        # done 상태도 재시도 허용 (단, done 상태인 파일/페이지는 제외)
        if job.status not in ("error", "cancelled", "done"):
            raise HTTPException(status_code=409, detail=f"retry is allowed only for error/cancelled/done jobs: {job.status}")

        job.cancel_requested = False
        job.error = None
        if job.kind == "pdf_upload":
            reset_processing = job_pages_repo.requeue_processing_pages(job.job_id)
            reset_error = job_pages_repo.requeue_failed_pages(job.job_id, reset_attempt=True)
            stats = job_pages_repo.get_job_page_stats(job.job_id)
            remaining = int(stats.get("queued", 0) or 0) + int(stats.get("processing", 0) or 0) + int(stats.get("error", 0) or 0)
            if remaining <= 0:
                raise HTTPException(status_code=409, detail="no remaining pages to retry")
            reset_count = int(reset_processing or 0) + int(reset_error or 0)
            add_job_log(job, "info", "retry", f"사용자 재시도 요청: 남은 페이지 {remaining}건을 이어서 처리합니다.")
        else:
            reset_count = prepare_files_retry(job)
            if reset_count <= 0:
                raise HTTPException(status_code=409, detail="no remaining files to retry")
            add_job_log(job, "info", "retry", f"사용자 재시도 요청: 남은 파일 {reset_count}건을 이어서 처리합니다.")

        job.status = "queued"
        start_job_thread(job_id)
        persist_runtime_manifests()
        return {"job": _job_summary(job, include_logs=True), "reset_count": reset_count}

    raise HTTPException(status_code=400, detail=f"invalid scope: {scope}")



@router.post("/api/jobs/{job_id}/files/{file_id}/retry")
async def retry_job_file(job_id: str, file_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")

    stored = FILES.get(file_id)
    if not stored:
        raise HTTPException(status_code=404, detail="file not found")
    
    # job.file_ids 체크 대신 stored.job_id 체크 (OCR 실패 등으로 file_ids에 추가되지 않은 경우 처리)
    if getattr(stored, "job_id", None) != job_id:
        raise HTTPException(status_code=400, detail="file does not belong to this job")
    
    # file_id가 job.file_ids에 없으면 추가 (재처리 가능하도록)
    if file_id not in (job.file_ids or []):
        job.file_ids.append(file_id)

    stored.status = "queued"
    stored.error = None
    job.error = None

    if job.kind == "pdf_upload" and getattr(stored, "page_no", None) is not None:
        page_index = max(0, int(stored.page_no) - 1)
        job_pages_repo.requeue_page(job_id, page_index, reset_attempt=False)
        add_job_log(job, "info", "retry", f"사용자 요청으로 페이지 {stored.page_no} 재처리를 시작합니다.")
    else:
        add_job_log(job, "info", "retry", f"사용자 요청으로 파일 재처리를 시작합니다: {stored.original_name}")

    if job.status in ("done", "error", "cancelled"):
        job.cancel_requested = False
        job.status = "queued"
        start_job_thread(job_id)

    persist_runtime_manifests()
    return {"job": _job_summary(job, include_logs=True), "file": file_summary(file_id)}


@router.post("/api/jobs/{job_id}/pages/{page_no}/retry")
async def retry_pdf_page(job_id: str, page_no: int):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    if job.kind != "pdf_upload":
        raise HTTPException(status_code=400, detail="page retry is only supported for pdf jobs")
    if int(page_no or 0) <= 0:
        raise HTTPException(status_code=400, detail="invalid page number")

    page_index = int(page_no) - 1
    affected = job_pages_repo.requeue_page(job_id, page_index, reset_attempt=False)
    if affected <= 0:
        raise HTTPException(status_code=404, detail="page not found")

    # job_pages 테이블에서 회전 정보 조회
    page_rotation = job_pages_repo.get_page_rotation(job_id, page_index)

    linked = None
    for fid, f in FILES.items():
        if getattr(f, "job_id", None) == job_id and int(getattr(f, "page_no", -1) or -1) == int(page_no):
            linked = f
            f.status = "queued"
            f.error = None
            # 회전 정보가 있으면 파일에 적용
            if page_rotation is not None:
                f.rotation = page_rotation
                add_job_log(job, "info", "retry", f"페이지 {page_no} 회전 정보 적용: {page_rotation}")
            break

    job.error = None
    add_job_log(job, "info", "retry", f"사용자 요청으로 PDF {page_no}페이지 재처리를 시작합니다.")

    if job.status in ("done", "error", "cancelled"):
        job.cancel_requested = False
        job.status = "queued"
        start_job_thread(job_id)

    persist_runtime_manifests()
    return {
        "job": _job_summary(job, include_logs=True),
        "page_no": int(page_no),
        "linked_file_id": getattr(linked, "file_id", None),
    }


@router.post("/api/jobs/{job_id}/pages/{page_no}/override", response_model=OverrideResponse)
async def override_pdf_page(job_id: str, page_no: int, payload: PageOverrideRequest):
    job = JOBS.get(job_id)
    if not job:
        raise NotFoundAppError("JOB_NOT_FOUND", "job not found")
    if job.kind != "pdf_upload":
        raise OverrideValidationError("page override is only supported for pdf jobs")
    if int(page_no or 0) <= 0:
        raise OverrideValidationError("invalid page number")
    if fitz is None:
        raise HTTPException(status_code=500, detail="PyMuPDF(fitz) is required")

    is_interest = payload.is_interest
    rotation = payload.rotation
    reprocess = bool(payload.reprocess)
    page_index = int(page_no) - 1

    if payload.page_no is not None and int(payload.page_no) != int(page_no):
        raise OverrideValidationError("page_no in body must match path page_no")

    if is_interest is None:
        raise OverrideValidationError("is_interest is required")

    pdf_path = Path(job.pdf_path or "")
    if not pdf_path.exists():
        raise NotFoundAppError("PDF_FILE_NOT_FOUND", "pdf file missing")

    stem = Path(job.pdf_name or f"{job.job_id}.pdf").stem
    with fitz.open(str(pdf_path)) as doc:
        if page_index < 0 or page_index >= int(doc.page_count or 0):
            raise NotFoundAppError("PAGE_NOT_FOUND", "page not found in pdf")
        page = doc.load_page(page_index)
        zoom = max(1, int(job.pdf_dpi or 300)) / 72.0
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        png_bytes = pix.tobytes("png")

    linked = None
    for f in FILES.values():
        if getattr(f, "job_id", None) == job_id and int(getattr(f, "page_no", -1) or -1) == int(page_no):
            linked = f
            break

    if linked is None:
        filename = f"{stem}_{page_no:04d}.png"
        out_path = config.DERIVED_DIR / f"{uuid.uuid4().hex}_{filename}"
        try:
            out_path.write_bytes(png_bytes)
        except Exception as exc:
            raise VirtualPageMaterializationError("failed to materialize virtual page image", detail=str(exc), retryable=False)
        linked = create_stored_file(
            "pdf_page",
            original_name=filename,
            stored_path=out_path,
            rotation=(rotation if rotation is not None else job.pdf_rotation),
            job_id=job_id,
            page_no=page_no,
            is_interest=bool(is_interest),
        )
        if linked.file_id not in (job.file_ids or []):
            job.file_ids.append(linked.file_id)

    result = apply_file_override(
        linked,
        is_interest_raw=is_interest,
        rotation_raw=rotation,
        reprocess=reprocess,
        job=job,
        page_index=page_index,
        log_fn=lambda level, stage, message: add_job_log(job, level, stage, f"페이지 {page_no}: {message}"),
    )
    
    # reprocess=True인 경우 job.progress 업데이트 (상태는 apply_file_override 내부에서 관리)
    if reprocess:
        from ..services.jobs_service import _sync_pdf_progress
        _sync_pdf_progress(job)
        add_job_log(job, "info", "override", f"페이지 {page_no} OCR 재처리 시작")
    
    return {"job": _job_summary(job, include_logs=True), "file": file_summary(linked.file_id), **{k: v for k, v in result.items() if k in ("ok", "reprocess")}}

@router.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")

    file_ids = list(job.file_ids or [])
    removed_files = 0
    deleted_db_records = 0
    deleted_files_count = 0
    deleted_job_pages_count = 0
    
    from ..repositories import db_repo
    from ..repositories import job_pages_repo
    from core import ocr_db
    import logging
    logger = logging.getLogger("api")
    
    try:
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        try:
            # 1. 각 파일의 OCR 결과 데이터 삭제 (동적 테이블)
            for file_id in file_ids:
                stored_file = FILES.get(file_id)
                if stored_file and stored_file.result:
                    # DB에서 해당 파일의 데이터 찾기 및 삭제
                    image_name = stored_file.result.get("image_name") or stored_file.original_name
                    from ..utils import derive_table_name
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
                        deleted_db_records += len(existing_ids)
                        logger.info(f"Deleted {len(existing_ids)} DB records for file {file_id} in job {job_id}")
            
            # 2. files 테이블에서 해당 job_id의 모든 파일 삭제
            deleted_files_count = db_repo.delete_files_by_job_id(conn, job_id)
            logger.info(f"Deleted {deleted_files_count} files from files table for job {job_id}")
            
            # 3. jobs 테이블에서 해당 job 삭제
            deleted_job = db_repo.delete_job(conn, job_id)
            logger.info(f"Deleted job {job_id} from jobs table")
            
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception as e:
        logger.error(f"Failed to delete DB records for job {job_id}: {e}")
    
    # 4. job_pages 테이블에서 해당 job의 모든 페이지 삭제
    try:
        deleted_job_pages_count = job_pages_repo.delete_job_pages(job_id)
        logger.info(f"Deleted {deleted_job_pages_count} pages from job_pages table for job {job_id}")
    except Exception as e:
        logger.error(f"Failed to delete job_pages for job {job_id}: {e}")
    
    # 5. 메모리에서 파일 삭제
    for file_id in file_ids:
        if FILES.pop(file_id, None):
            removed_files += 1

    # 6. 메모리에서 작업 삭제
    JOBS.pop(job_id, None)
    persist_runtime_manifests()
    
    return {
        "ok": True, 
        "deleted_job_id": job_id, 
        "deleted_file_ids": file_ids, 
        "removed_files": removed_files,
        "deleted_db_records": deleted_db_records,
        "deleted_files_count": deleted_files_count,
        "deleted_job_pages_count": deleted_job_pages_count
    }


@router.post("/api/jobs/{job_id}/mark_done")
async def mark_job_done(job_id: str, request: Request):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    
    # 모든 상태에서 완료 가능하도록 변경 (done 상태 제외)
    if job.status == "done":
        raise HTTPException(status_code=400, detail="Job is already in done status")
    
    try:
        body = await request.json()
    except Exception:
        body = {}
    
    reason = body.get("reason", "수동 완료")
    
    job.status = "done"
    job.error = None
    add_job_log(job, "info", "mark_done", f"사용자 요청으로 작업을 완료 상태로 변경했습니다: {reason}")
    
    persist_runtime_manifests()
    return {"job": _job_summary(job, include_logs=True)}


# UI에서 이미지 올린 후, 업로드 + 처리 버튼을 누르면 api.js에서 호출하는 API
# directory 생성 및 job 생성, 이미지의 저장을 담당함
# 현재 난잡하게 서비스 로직이랑 이거저거 섞여있어서, 분리할 필요가 있음

@router.post("/api/upload/images")
async def upload_images(
    files: List[UploadFile] = File(...),
    rotation: Optional[str] = Form(None),
):

    if not files:
        raise HTTPException(status_code=400, detail="no files")
    ensure_dirs()

    job_id = uuid.uuid4().hex
    job = Job(job_id=job_id, kind="image_upload")
    add_job_log(job, "info", "upload", "이미지 업로드 요청을 수신했습니다.")
    JOBS[job_id] = job
    
    # ========== DB에 직접 INSERT ==========
    try:
        from ..repositories import db_repo
        from core import ocr_db
        
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
            
            # INSERT 쿼리 실행
            cursor.execute("""
                INSERT INTO ocr_portfolio.jobs 
                (job_id, kind, created_ms, status, progress, error, cancel_requested, 
                 pdf_path, pdf_name, pdf_dpi, pdf_rotation, pdf_scan_done, name, log_seq, logs)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                job.job_id, job.kind, job.created_ms, job.status, 
                progress_json, job.error, cancel_requested, job.pdf_path, 
                job.pdf_name, job.pdf_dpi, job.pdf_rotation, pdf_scan_done, 
                job.name, job.log_seq, logs_json
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
        logger.error(f"DB INSERT 실패 (job_id={job_id}): {e}", exc_info=True)
    # ==========================================
    
    persist_runtime_manifests()

    first_name = None
    for upload_file in files:
        name = safe_name(upload_file.filename or "image")
        if first_name is None:
            first_name = name
        stored = config.UPLOADS_DIR / f"{uuid.uuid4().hex}_{name}"
        save_upload_to(stored, upload_file)
        stored_file = create_stored_file("image", original_name=name, stored_path=stored, rotation=rotation)
        job.file_ids.append(stored_file.file_id)

    add_job_log(job, "info", "upload", f"업로드 완료: {len(job.file_ids)}개 파일 저장")

    if len(files) > 1:
        job.name = f"{first_name} 외 {len(files) - 1}개"
    else:
        job.name = first_name or "image"

    job.progress = {"total": len(job.file_ids), "done": 0}
    start_job_thread(job_id)
    persist_runtime_manifests()
    return {"job_id": job_id}


@router.post("/api/upload/pdf")
async def upload_pdf(
    file: UploadFile = File(...),
    dpi: int = Form(300),
    rotation: Optional[str] = Form(None),
):
    ensure_dirs()
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="PDF only")

    pdf_name = safe_name(file.filename)
    pdf_path = config.PDFS_DIR / f"{uuid.uuid4().hex}_{pdf_name}"
    save_upload_to(pdf_path, file)

    job_id = uuid.uuid4().hex
    job = Job(
        job_id=job_id,
        kind="pdf_upload",
        pdf_path=str(pdf_path),
        pdf_name=pdf_name,
        pdf_dpi=int(dpi),
        pdf_rotation=rotation,
        name=pdf_name,
    )
    JOBS[job_id] = job
    
    # ========== DB에 직접 INSERT ==========
    try:
        from ..repositories import db_repo
        from core import ocr_db
        
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
            
            # INSERT 쿼리 실행
            cursor.execute("""
                INSERT INTO ocr_portfolio.jobs 
                (job_id, kind, created_ms, status, progress, error, cancel_requested, 
                 pdf_path, pdf_name, pdf_dpi, pdf_rotation, pdf_scan_done, name, log_seq, logs)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                job.job_id, job.kind, job.created_ms, job.status, 
                progress_json, job.error, cancel_requested, job.pdf_path, 
                job.pdf_name, job.pdf_dpi, job.pdf_rotation, pdf_scan_done, 
                job.name, job.log_seq, logs_json
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
        logger.error(f"DB INSERT 실패 (job_id={job_id}): {e}", exc_info=True)
    # ==========================================
    
    add_job_log(job, "info", "upload", "PDF 업로드 요청을 수신했습니다.")

    if fitz is None:
        add_job_log(job, "error", "fail", "PyMuPDF(fitz)가 없어 PDF 처리를 시작할 수 없습니다.")
        raise HTTPException(status_code=500, detail="PyMuPDF(fitz)가 필요합니다. `pip install pymupdf` 후 재시도하세요.")
    try:
        doc = fitz.open(str(pdf_path))
        total_pages = int(getattr(doc, "page_count", 0) or 0)
        try:
            doc.close()
        except Exception:
            pass
    except Exception as exc:
        add_job_log(job, "error", "fail", f"PDF 열기 실패: {exc}")
        raise HTTPException(status_code=500, detail=f"PDF 열기 실패: {exc}")

    job_pages_repo.init_job_pages_table()
    job_pages_repo.enqueue_job_pages(job_id, total_pages)

    job.progress = {"total": total_pages, "done": 0, "queued": total_pages, "remaining": total_pages, "retrying": 0, "interest": 0, "ocr_total": 0, "ocr_done": 0}
    add_job_log(job, "info", "upload", f"PDF 업로드 완료: 총 {total_pages}페이지 (job_pages queued 생성)")
    start_job_thread(job_id)
    persist_runtime_manifests()
    return {"job_id": job_id, "total_pages": total_pages}


@router.post("/api/upload/pdf/classification")
async def upload_pdf_classification(
    file: UploadFile = File(...),
    dpi: int = Form(300),
    rotation: Optional[str] = Form(None),
):
    """
    분류 탭 전용: PDF 업로드만 수행하고 자동 분류/OCR을 하지 않음
    모든 페이지를 비관심으로 설정하고 사용자가 직접 분류하도록 함
    """
    ensure_dirs()
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="PDF only")

    pdf_name = safe_name(file.filename)
    pdf_path = config.PDFS_DIR / f"{uuid.uuid4().hex}_{pdf_name}"
    save_upload_to(pdf_path, file)

    job_id = uuid.uuid4().hex
    job = Job(
        job_id=job_id,
        kind="pdf_upload",  # 같은 kind 사용하지만 처리 로직은 다름
        pdf_path=str(pdf_path),
        pdf_name=pdf_name,
        pdf_dpi=int(dpi),
        pdf_rotation=rotation,
        name=pdf_name,
    )
    JOBS[job_id] = job
    
    # ========== DB에 직접 INSERT ==========
    try:
        from ..repositories import db_repo
        from core import ocr_db
        
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
            
            # INSERT 쿼리 실행
            cursor.execute("""
                INSERT INTO ocr_portfolio.jobs 
                (job_id, kind, created_ms, status, progress, error, cancel_requested, 
                 pdf_path, pdf_name, pdf_dpi, pdf_rotation, pdf_scan_done, name, log_seq, logs)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                job.job_id, job.kind, job.created_ms, job.status, 
                progress_json, job.error, cancel_requested, job.pdf_path, 
                job.pdf_name, job.pdf_dpi, job.pdf_rotation, pdf_scan_done, 
                job.name, job.log_seq, logs_json
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
        logger.error(f"DB INSERT 실패 (job_id={job_id}): {e}", exc_info=True)
    # ==========================================
    
    add_job_log(job, "info", "upload", "분류 탭 PDF 업로드 요청을 수신했습니다. (자동 분류 없음)")

    if fitz is None:
        add_job_log(job, "error", "fail", "PyMuPDF(fitz)가 없어 PDF 처리를 시작할 수 없습니다.")
        raise HTTPException(status_code=500, detail="PyMuPDF(fitz)가 필요합니다. `pip install pymupdf` 후 재시도하세요.")
    try:
        doc = fitz.open(str(pdf_path))
        total_pages = int(getattr(doc, "page_count", 0) or 0)
        try:
            doc.close()
        except Exception:
            pass
    except Exception as exc:
        add_job_log(job, "error", "fail", f"PDF 열기 실패: {exc}")
        raise HTTPException(status_code=500, detail=f"PDF 열기 실패: {exc}")

    job_pages_repo.init_job_pages_table()
    job_pages_repo.enqueue_job_pages(job_id, total_pages)

    job.progress = {"total": total_pages, "done": 0, "queued": total_pages, "remaining": total_pages, "retrying": 0, "interest": 0, "ocr_total": 0, "ocr_done": 0}
    add_job_log(job, "info", "upload", f"분류 탭 PDF 업로드 완료: 총 {total_pages}페이지 (업로드 전용 작업 시작)")
    
    # 순차 처리를 위해 start_job_thread 사용 (run_pdf_upload_only_job을 직접 호출하지 않음)
    # run_job_with_cleanup이 run_pdf_upload_only_job을 호출하도록 수정 필요
    start_job_thread(job_id)
    
    # ✅ 성능 최적화: 마지막 persist_runtime_manifests()만 유지 (응답 속도 개선)
    persist_runtime_manifests()
    return {"job_id": job_id, "total_pages": total_pages}


# 분류 페이지 API: 페이지 목록 조회
@router.get("/api/jobs/{job_id}/pages")
async def get_job_pages(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    
    # ✅ 메모리 상태(FILES)를 기반으로 페이지 목록 생성 (DB 조회 대신)
    # SSE로 메모리 상태가 변했으므로 메모리 상태를 우선 조회
    
    # DB에서 전체 페이지 정보 가져오기 (기본 정보용)
    db_pages = job_pages_repo.list_job_pages(job_id)
    
    # 메모리 상태로 업데이트
    pages = []
    for db_page in db_pages:
        page_index = db_page.get("page_index")
        file_id = db_page.get("file_id")
        
        # 메모리에서 해당 파일의 상태 확인
        memory_status = None
        memory_error = None
        if file_id:
            stored_file = FILES.get(file_id)
            if stored_file:
                memory_status = stored_file.status
                memory_error = stored_file.error
        
        # 메모리 상태가 있으면 메모리 상태 우선, 없으면 DB 상태 사용
        final_status = memory_status if memory_status else db_page.get("status")
        final_error = memory_error if memory_error is not None else db_page.get("last_error")
        
        # 페이지 정보 생성 (메모리 상태 반영)
        page_info = {
            "job_id": db_page.get("job_id"),
            "page_index": page_index,
            "status": final_status,  # ← 메모리 상태 우선
            "attempt": db_page.get("attempt"),
            "is_interest": db_page.get("is_interest"),
            "file_id": file_id,
            "stored_path": db_page.get("stored_path"),
            "rotation": db_page.get("rotation"),
            "last_error": final_error,  # ← 메모리 에러 우선
            "updated_ms": db_page.get("updated_ms"),
            "classification_status": db_page.get("classification_status", "queued")  # ✅ classification_status 추가
        }
        pages.append(page_info)
    
    return {"pages": pages}


# 분류 페이지 API: 페이지 분류 정보 저장
@router.post("/api/jobs/{job_id}/pages/{page_index}/classification")
async def save_page_classification(job_id: str, page_index: int, request: Request):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    
    is_interest = body.get("is_interest")
    rotation = body.get("rotation")
    classification_status = body.get("classification_status", "queued")  # ✅ classification_status 추가
    
    if is_interest is None:
        raise HTTPException(status_code=400, detail="is_interest is required")
    
    # ✅ 성능 최적화: 단일 페이지 조회 사용 (전체 페이지 조회 대신)
    target_page = job_pages_repo.get_page_by_index(job_id, page_index)
    file_id = target_page.get("file_id") if target_page else None
    
    # 분류 정보 저장
    affected = job_pages_repo.update_page_classification(
        job_id, 
        page_index, 
        bool(is_interest), 
        rotation,
        classification_status  # ✅ classification_status 전달
    )
    
    if affected <= 0:
        raise HTTPException(status_code=404, detail="page not found")
    
    # ✅ FILES 메모리 상태에도 classification_status 업데이트 (서버 재시작 시 상황 복구)
    if file_id and file_id in FILES:
        FILES[file_id].classification_status = classification_status
        persist_runtime_manifests_debounced()
    
    # 관심 문서이고 OCR이 아직 안된 경우, OCR 처리 시작
    if bool(is_interest):
        if target_page and target_page.get("status") != "done":
            # 관심 문서로 변경되었고 OCR이 안된 경우, OCR 처리 시작
            if file_id:
                stored = FILES.get(file_id)
                if stored:
                    stored.status = "queued"
                    stored.error = None
                    stored.is_interest = 1
                    
                    # 회전 정보가 있으면 파일에 적용
                    if rotation is not None:
                        stored.rotation = rotation
                        add_job_log(job, "info", "classification", f"페이지 {page_index + 1} 회전 정보 적용: {rotation}")
                        # 중요: rotation 변경 후 manifest 저장 (디바운싱 적용)
                        persist_runtime_manifests_debounced()
                    
                    # ✅ 성능 최적화: 통합 업데이트 사용 (단일 트랜잭션)
                    job_pages_repo.update_page_classification_complete(
                        job_id, 
                        page_index, 
                        bool(is_interest), 
                        rotation,
                        status="queued",
                        file_id=file_id
                    )
                    
                    # 작업이 완료/에러 상태면 재시작
                    if job.status in ("done", "error", "cancelled"):
                        job.cancel_requested = False
                        job.status = "queued"
                        start_job_thread(job_id)
                    
                    add_job_log(job, "info", "classification", f"페이지 {page_index + 1}를 관심문서로 분류하여 OCR 처리를 시작합니다.")
            else:
                # ✅ file_id가 없는 경우: 상태를 queued로 변경 (file_id 생성 후 OCR 처리 시작)
                # 이 경우 페이지는 가상 페이지이므로 상태만 업데이트하고 OCR 처리는 file_id 생성 후 시작
                job_pages_repo.update_page_status(job_id, page_index, "queued")
                add_job_log(job, "info", "classification", f"페이지 {page_index + 1}를 관심문서로 분류하여 상태를 queued로 변경했습니다 (file_id 생성 대기 중).")
    
    # storedfile 상태 변경 후 job.progress 업데이트 (분류 탭에서 정확한 진행률 표시를 위해)
    update_job_progress_from_files(job_id)
    
    return {"ok": True, "page_index": page_index, "is_interest": bool(is_interest), "rotation": rotation}


# 분류 페이지 API: 페이지 OCR 처리 취소
@router.post("/api/jobs/{job_id}/pages/{page_no}/cancel")
async def cancel_page_ocr(job_id: str, page_no: int):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    
    if int(page_no or 0) <= 0:
        raise HTTPException(status_code=400, detail="invalid page number")
    
    page_index = int(page_no) - 1
    
    # ✅ 성능 최적화: 단일 페이지 조회 사용 (전체 페이지 조회 대신)
    target_page = job_pages_repo.get_page_by_index(job_id, page_index)
    
    if not target_page:
        raise HTTPException(status_code=404, detail="page not found")
    
    file_id = target_page.get("file_id")
    if file_id:
        stored = FILES.get(file_id)
        if stored:
            # 파일 상태를 done으로 변경 (OCR 처리 취소)
            stored.status = "done"
            stored.is_interest = 0
            add_job_log(job, "info", "cancel", f"페이지 {page_no} OCR 처리가 취소되었습니다 (비관심으로 변경).")
    
    # ✅ 성능 최적화: 통합 업데이트 사용 (단일 트랜잭션)
    job_pages_repo.update_page_classification_complete(
        job_id, 
        page_index, 
        is_interest=False, 
        rotation=None,
        status="done",
        file_id=file_id
    )
    
    # storedfile 상태 변경 후 job.progress 업데이트 (분류 탭에서 정확한 진행률 표시를 위해)
    update_job_progress_from_files(job_id)
    
    persist_runtime_manifests_debounced()
    return {"ok": True, "page_no": page_no, "cancelled": True}
