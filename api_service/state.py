from __future__ import annotations

import threading
from typing import Dict, List, Any

from .models import Job, StoredFile

JOBS: Dict[str, Job] = {}
FILES: Dict[str, StoredFile] = {}

SYSTEM_LOGS: List[Dict[str, Any]] = []
SYSTEM_LOG_SEQ: int = 0

FILE_SOURCE_INDEX: Dict[str, str] = {}

# ✅ 성능 최적화: 작업별 파일 인덱스 추가
FILES_BY_JOB: Dict[str, List[str]] = {}

# Thread-safe locks for state management
STATE_LOCK = threading.RLock()

# Job queue management (sequential processing)
ACTIVE_JOB_LOCK = threading.Lock()
ACTIVE_JOB_ID = None
JOB_QUEUE = []


def rebuild_file_source_index() -> None:
    FILE_SOURCE_INDEX.clear()
    for stored in FILES.values():
        job_id = getattr(stored, "job_id", None)
        page_no = getattr(stored, "page_no", None)
        if not job_id or page_no is None:
            continue
        try:
            source_key = f"{str(job_id)}:{int(page_no)}"
        except Exception:
            continue
        FILE_SOURCE_INDEX[source_key] = stored.file_id


# ✅ 성능 최적화: 작업별 파일 인덱스 관리 함수 추가
def add_file_to_job_index(file_id: str, job_id: str) -> None:
    """파일을 작업 인덱스에 추가"""
    if not job_id:
        return
    with STATE_LOCK:
        if job_id not in FILES_BY_JOB:
            FILES_BY_JOB[job_id] = []
        if file_id not in FILES_BY_JOB[job_id]:
            FILES_BY_JOB[job_id].append(file_id)


def remove_file_from_job_index(file_id: str, job_id: str) -> None:
    """파일을 작업 인덱스에서 제거"""
    if not job_id:
        return
    with STATE_LOCK:
        if job_id in FILES_BY_JOB and file_id in FILES_BY_JOB[job_id]:
            FILES_BY_JOB[job_id].remove(file_id)


def rebuild_job_file_index() -> None:
    """모든 파일에 대해 작업 인덱스 재구축"""
    with STATE_LOCK:
        FILES_BY_JOB.clear()
        for file_id, stored in FILES.items():
            job_id = getattr(stored, "job_id", None)
            if job_id:
                if job_id not in FILES_BY_JOB:
                    FILES_BY_JOB[job_id] = []
                if file_id not in FILES_BY_JOB[job_id]:
                    FILES_BY_JOB[job_id].append(file_id)
