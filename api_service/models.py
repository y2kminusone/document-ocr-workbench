from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from pydantic import BaseModel

from .utils import now_ms


@dataclass
class StoredFile:
    file_id: str
    kind: str  # "image" | "pdf_page"
    original_name: str
    stored_path: str
    created_ms: int = field(default_factory=now_ms)
    status: str = "queued"  # queued|processing|done|error|cancelled
    error: Optional[str] = None
    rotation: Optional[str] = None
    result: Optional[Dict[str, Any]] = None
    job_id: Optional[str] = None
    page_no: Optional[int] = None
    is_interest: Optional[bool] = None
    classification_status: Optional[str] = "queued"  # ✅ 분류 탭 전용 상태: queued|requested
    stage_stats: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Job:
    job_id: str
    kind: str  # "image_upload" | "pdf_upload"
    created_ms: int = field(default_factory=now_ms)
    status: str = "queued"  # queued|processing|paused|done|error|cancelled
    progress: Dict[str, Any] = field(default_factory=lambda: {"total": 0, "done": 0})
    file_ids: List[str] = field(default_factory=list)
    error: Optional[str] = None
    cancel_requested: bool = False  # cancel 신호(중단 후 retry 가능)
    pdf_path: Optional[str] = None
    pdf_name: Optional[str] = None
    pdf_dpi: Optional[int] = None
    pdf_rotation: Optional[str] = None
    pdf_scan_done: bool = False
    name: Optional[str] = None
    log_seq: int = 0
    logs: List[Dict[str, Any]] = field(default_factory=list)


class DBConfigPayload(BaseModel):
    host: str = "127.0.0.1"
    port: int = 3306
    user: str = ""
    password: str = ""
    database: str = "ocr_portfolio"
    table_name: str = "ocr_results"


class ResultUpdatePayload(BaseModel):
    title: Optional[str] = None
    table: List[Dict[str, Any]] = []
    columns: Optional[List[str]] = None


class DBRowUpdatePayload(BaseModel):
    title: Optional[str] = None
    data: Dict[str, Any] = {}


class SaveToDbPayload(BaseModel):
    title: Optional[str] = None
    table: List[Dict[str, Any]] = []
    columns: Optional[List[str]] = None
    image_name: Optional[str] = None


from pydantic import Field, PositiveInt, validator
from typing import Literal


class PipelineStage(BaseModel):
    status: str = "n/a"
    elapsed_ms: int = 0
    error: Optional[str] = None
    error_code: Optional[str] = None
    retryable: Optional[bool] = None


class PipelineDebug(BaseModel):
    stages: Dict[str, PipelineStage] = Field(default_factory=dict)
    pipeline_elapsed_ms: Optional[int] = None
    fallback_used: Optional[bool] = None
    decision: Optional[str] = None
    failed_stage: Optional[str] = None
    error_code: Optional[str] = None
    retryable: Optional[bool] = None


class FileOverrideRequest(BaseModel):
    is_interest: Optional[bool] = None
    rotation: Optional[Literal["cw", "ccw", "180"]] = None
    reprocess: bool = True

    @validator("rotation", pre=True)
    def normalize_rotation(cls, v):
        if v in ("", "none", "None"):
            return None
        return v


class PageOverrideRequest(FileOverrideRequest):
    page_no: Optional[PositiveInt] = None


class OverrideResponse(BaseModel):
    ok: bool = True
    reprocess: bool
    file: Dict[str, Any]
    job: Optional[Dict[str, Any]] = None


class JobFileSummary(BaseModel):
    file_id: str
    kind: str
    original_name: str
    created_ms: int
    status: str
    error: Optional[str] = None
    rotation: Optional[str] = None
    is_interest: Optional[bool] = None
    stage_stats: Dict[str, Any] = Field(default_factory=dict)
    page_no: Optional[int] = None
    virtual: Optional[bool] = None
