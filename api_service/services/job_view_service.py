from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List

from ..models import Job
from ..repositories import job_pages_repo
from ..state import FILES, FILES_BY_JOB


def file_summary(file_id: str) -> Dict[str, Any]:
    stored = FILES.get(file_id)
    if not stored:
        return {"file_id": file_id}
    return {
        "file_id": stored.file_id,
        "kind": stored.kind,
        "original_name": stored.original_name,
        "created_ms": stored.created_ms,
        "status": stored.status,
        "error": stored.error,
        "rotation": stored.rotation,
        "is_interest": stored.is_interest,
        "stage_stats": stored.stage_stats,
    }


def _pdf_page_virtual_file(job: Job, page: Dict[str, Any]) -> Dict[str, Any]:
    page_index = int(page.get("page_index", 0) or 0)
    page_no = page_index + 1
    pdf_name = Path(job.pdf_name or f"{job.job_id}.pdf").stem

    page_file_id = page.get("file_id")
    stored_file = FILES.get(page_file_id) if page_file_id else None

    if stored_file:
        return {
            "file_id": stored_file.file_id,
            "kind": "pdf_page",
            "original_name": stored_file.original_name,
            "stored_path": stored_file.stored_path,
            "created_ms": stored_file.created_ms,
            "status": stored_file.status,
            "error": stored_file.error,
            "rotation": stored_file.rotation or page.get("rotation"),  # ← 메모리 우선: stored_file.rotation 사용
            "is_interest": stored_file.is_interest,
            "stage_stats": stored_file.stage_stats,
            "page_no": page_no,
            "virtual": False,
            "attempt": int(page.get("attempt", 0) or 0),
        }

    # 비관심문서도 stored_path 포함 (이미지는 저장되었으므로)
    return {
        "file_id": f"virtual:{job.job_id}:{page_no}",
        "kind": "pdf_page",
        "original_name": f"{pdf_name}_{page_no:04d}.png",
        "stored_path": page.get("stored_path"),  # ← stored_path 추가
        "created_ms": job.created_ms,
        "status": str(page.get("status") or "queued"),
        "error": page.get("last_error"),
        "rotation": page.get("rotation"),  # ← job.pdf_rotation 대신 page.rotation 사용
        "is_interest": page.get("is_interest"),
        "stage_stats": {},
        "page_no": page_no,
        "virtual": True,
        "attempt": int(page.get("attempt", 0) or 0),
    }


def job_files_with_virtual(job: Job) -> List[Dict[str, Any]]:
    # ✅ 성능 최적화: 인덱스를 사용한 빠른 파일 조회
    job_id = job.job_id
    
    # 인덱스에서 파일 ID 목록 가져오기 (전체 FILES 순회 불필요)
    indexed_file_ids = FILES_BY_JOB.get(job_id, [])
    
    # 인덱스가 없거나 비어있으면 기존 방식 사용 (호환성 유지)
    if not indexed_file_ids:
        files = [asdict(FILES[fid]) for fid in job.file_ids if fid in FILES]
    else:
        # 인덱스를 사용하여 파일 조회 (빠름)
        files = [asdict(FILES[fid]) for fid in indexed_file_ids if fid in FILES]
    
    if job.kind != "pdf_upload":
        files.sort(key=lambda f: (0 if f.get("page_no") is not None else 1, int(f.get("page_no", 0) or 0), int(f.get("created_ms", 0) or 0)))
        return files

    try:
        pages = job_pages_repo.list_job_pages(job.job_id, limit=5000)
    except Exception:
        pages = []

    file_ids = {f.get("file_id") for f in files if isinstance(f, dict)}
    for page in pages:
        page_file_id = page.get("file_id")
        if page_file_id and page_file_id in file_ids:
            continue
        files.append(_pdf_page_virtual_file(job, page))

    files.sort(key=lambda f: (0 if f.get("page_no") is not None else 1, int(f.get("page_no", 0) or 0), int(f.get("created_ms", 0) or 0)))
    return files
