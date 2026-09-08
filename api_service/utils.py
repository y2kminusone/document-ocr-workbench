from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Optional

import requests

from . import config


def now_ms() -> int:
    return int(time.time() * 1000)


def safe_name(name: str) -> str:
    cleaned = (name or "").strip().replace("\\", "_").replace("/", "_")
    return cleaned or "file"


def derive_table_name(image_name: str) -> str:
    base = os.path.splitext(os.path.basename(image_name or ""))[0]
    if not base:
        return "ocr_results"
    match = re.match(r"^(.*)_\d+$", base)
    prefix = (match.group(1) if match else base).strip()
    prefix = prefix.replace(" ", "_")
    prefix = re.sub(r"[^a-zA-Z0-9_-]", "_", prefix)
    prefix = prefix.strip("_-")
    if not prefix:
        return "ocr_results"
    if len(prefix) > 64:
        prefix = prefix[:64]
    return prefix


def save_upload_to(path: Path, upload_file) -> None:
    with path.open("wb") as out:
        while True:
            chunk = upload_file.file.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)


def ensure_dirs() -> None:
    config.ensure_dirs()


def maybe_rotation_from_doc_index(doc_index: Optional[int]) -> Optional[str]:
    if doc_index == 1 or doc_index == 3:
        return "cw"   # 시계방향 90도
    # doc_index == 0 또는 2: 회전 없음
    return None


def classify_exception(exc: Exception) -> str:
    msg = str(exc or "").strip()
    lowered = msg.lower()

    if isinstance(exc, TimeoutError) or "timeout" in lowered or "timed out" in lowered:
        return "TIMEOUT"
    if isinstance(exc, MemoryError) or "out of memory" in lowered or "cannot allocate memory" in lowered:
        return "MEMORY"
    if isinstance(exc, requests.exceptions.Timeout):
        return "TIMEOUT"
    if isinstance(exc, requests.exceptions.ConnectionError):
        return "NETWORK"
    if isinstance(exc, requests.exceptions.HTTPError):
        status = None
        try:
            status = int(getattr(getattr(exc, "response", None), "status_code", 0) or 0)
        except Exception:
            status = 0
        if status == 404:
            return "HTTP_404"
        if status == 429:
            return "HTTP_429"
        if status >= 500:
            return "HTTP_5XX"
        return "HTTP"
    if isinstance(exc, FileNotFoundError):
        return "FILE_NOT_FOUND"
    if isinstance(exc, PermissionError):
        return "PERMISSION"
    if isinstance(exc, ValueError):
        return "VALUE"
    if "connection reset" in lowered or "broken pipe" in lowered:
        return "NETWORK_RESET"
    if "too many requests" in lowered:
        return "HTTP_429"
    if "ssl" in lowered or "certificate" in lowered:
        return "TLS"
    cls_name = exc.__class__.__name__ if exc is not None else "Exception"
    return f"UNKNOWN_{cls_name}"


def format_exception_for_log(exc: Exception) -> str:
    kind = classify_exception(exc)
    return f"[{kind}] {exc}"
