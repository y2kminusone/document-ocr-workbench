from __future__ import annotations

import time
from typing import Any, Dict, Optional

from ..errors import AppError


def build_stage(
    status: str,
    elapsed_ms: int,
    *,
    error: Optional[str] = None,
    error_code: Optional[str] = None,
    retryable: Optional[bool] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    item: Dict[str, Any] = {
        "status": str(status or "n/a"),
        "elapsed_ms": max(0, int(elapsed_ms or 0)),
    }
    if error:
        item["error"] = str(error)
    if error_code:
        item["error_code"] = str(error_code)
    if retryable is not None:
        item["retryable"] = bool(retryable)
    if isinstance(extra, dict):
        item.update(extra)
    return item


def derive_failed_stage(stages: Dict[str, Any]) -> Optional[str]:
    if not isinstance(stages, dict):
        return None
    for name in ("doc_filter", "yolo", "ocr", "override"):
        row = stages.get(name)
        if not isinstance(row, dict):
            continue
        status = str(row.get("status") or "").lower()
        if status in ("error", "failed", "fail"):
            return name
    return None


def finalize_debug(debug: Dict[str, Any], *, started_at: float, fallback_used: bool = False, decision: Optional[str] = None) -> Dict[str, Any]:
    out = dict(debug or {})
    out["pipeline_elapsed_ms"] = max(0, int((time.perf_counter() - float(started_at or time.perf_counter())) * 1000))
    stages = out.get("stages") if isinstance(out.get("stages"), dict) else {}
    out["stages"] = stages
    out["fallback_used"] = bool(fallback_used)
    failed_stage = derive_failed_stage(stages)
    if failed_stage:
        out["failed_stage"] = failed_stage
    if decision:
        out["decision"] = decision
    return out


def stage_stats_from_result(result: Optional[Dict[str, Any]], fallback: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    debug = (result or {}).get("_debug") if isinstance(result, dict) else None
    if isinstance(debug, dict) and isinstance(debug.get("stages"), dict):
        return dict(debug.get("stages") or {})
    if isinstance(fallback, dict):
        return dict(fallback)
    return {}


def error_meta_from_exception(exc: Exception) -> Dict[str, Any]:
    if isinstance(exc, AppError):
        return {
            "error_code": exc.code,
            "retryable": exc.retryable,
            "failed_stage": exc.stage,
            "message": exc.message,
        }
    return {"error_code": "UNEXPECTED_ERROR", "retryable": False}
