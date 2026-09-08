from __future__ import annotations

import json
from collections import deque
from pathlib import Path
from typing import Any, Dict, List, Tuple

from .. import config

SYSTEM_LOG_FILE = config.STORAGE_DIR / "system_logs.jsonl"


def _ensure_parent_dir() -> None:
    SYSTEM_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)


def append_system_log(item: Dict[str, Any]) -> None:
    _ensure_parent_dir()
    with SYSTEM_LOG_FILE.open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(item, ensure_ascii=False) + "\n")


def read_recent_system_logs(limit: int = 300) -> List[Dict[str, Any]]:
    lim = max(1, min(int(limit or 300), 2000))
    if not SYSTEM_LOG_FILE.exists():
        return []

    rows: "deque[Dict[str, Any]]" = deque(maxlen=lim)
    with SYSTEM_LOG_FILE.open("r", encoding="utf-8") as fp:
        for line in fp:
            text = line.strip()
            if not text:
                continue
            try:
                obj = json.loads(text)
            except Exception:
                continue
            if isinstance(obj, dict):
                rows.append(obj)
    return list(rows)


def read_system_logs_since(offset: int) -> Tuple[List[Dict[str, Any]], int]:
    if not SYSTEM_LOG_FILE.exists():
        return [], 0

    path: Path = SYSTEM_LOG_FILE
    size = path.stat().st_size
    if offset < 0 or offset > size:
        offset = 0

    items: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fp:
        fp.seek(offset)
        chunk = fp.read()
        next_offset = fp.tell()

    for line in (chunk or "").splitlines():
        text = line.strip()
        if not text:
            continue
        try:
            obj = json.loads(text)
        except Exception:
            continue
        if isinstance(obj, dict):
            items.append(obj)

    return items, next_offset



def get_system_logs_size() -> int:
    if not SYSTEM_LOG_FILE.exists():
        return 0
    try:
        return int(SYSTEM_LOG_FILE.stat().st_size)
    except Exception:
        return 0
