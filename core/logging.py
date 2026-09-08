from __future__ import annotations

import logging
import os
import re
import time
import uuid
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


DEFAULT_LOG_DIR = Path(os.getenv("LOG_DIR", "./logs")).resolve()
DEFAULT_LOG_LEVEL = os.getenv("LOG_LEVEL", "DEBUG").upper()


def _ensure_log_dir(log_dir: Path) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)


def _build_handler(log_dir: Path, service_name: str, use_rotation: bool = True) -> logging.Handler:
    _ensure_log_dir(log_dir)
    file_path = log_dir / f"{service_name}.log"
    
    if use_rotation:
        handler = TimedRotatingFileHandler(
            filename=str(file_path),
            when="midnight",
            interval=1,
            backupCount=14,
            encoding="utf-8",
            utc=False,
        )
        handler.suffix = "%Y%m%d"
    else:
        # Use regular FileHandler when rotation is disabled (for multiprocessing)
        handler = logging.FileHandler(
            filename=str(file_path),
            mode="a",
            encoding="utf-8",
        )
    
    return handler


# ✅ INFO 레벨 로그만 제외하는 필터 클래스
class NoInfoFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return record.levelno != logging.INFO  # INFO만 제외 (DEBUG, WARNING, ERROR 허용)


class RedactSensitiveFilter(logging.Filter):
    """로그 내 image_url/base64 payload를 마스킹한다."""

    _patterns = [
        (re.compile(r"data:image/[^;]+;base64,[A-Za-z0-9+/=]+"), "<redacted:data-url-base64>"),
        (re.compile(r"(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{200,}={0,2}(?![A-Za-z0-9+/=])"), "<redacted:base64>"),
        (re.compile(r"('image_url'\s*:\s*\{\s*'url'\s*:\s*')[^']+"), r"\1<redacted:image-url>"),
        (re.compile(r'("image_url"\s*:\s*\{\s*"url"\s*:\s*")[^"]+'), r"\1<redacted:image-url>"),
    ]

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        for pattern, replacement in self._patterns:
            msg = pattern.sub(replacement, msg)
        record.msg = msg
        record.args = ()
        return True


def init_logging(service_name: str, log_dir: Optional[Path] = None, level: Optional[str] = None, use_rotation: bool = True) -> dict:
    log_dir = log_dir or DEFAULT_LOG_DIR
    level_name = (level or DEFAULT_LOG_LEVEL).upper()
    log_level = getattr(logging, level_name, logging.DEBUG)  # 기본 DEBUG

    file_handler = _build_handler(log_dir, service_name, use_rotation=use_rotation)
    stream_handler = logging.StreamHandler()

    formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s")
    file_handler.setFormatter(formatter)
    stream_handler.setFormatter(formatter)

    # INFO 제외 필터 비활성화 - YOLO 서버 디버깅을 위해 모든 로그 기록
    # no_info_filter = NoInfoFilter()
    redact_filter = RedactSensitiveFilter()
    # file_handler.addFilter(no_info_filter)  # 주석 처리하여 INFO 로그도 기록
    # stream_handler.addFilter(no_info_filter)  # 주석 처리하여 INFO 로그도 기록
    file_handler.addFilter(redact_filter)
    stream_handler.addFilter(redact_filter)

    root = logging.getLogger()
    root.setLevel(log_level)

    # 기존 핸들러 제거
    for handler in list(root.handlers):
        root.removeHandler(handler)

    root.addHandler(file_handler)
    root.addHandler(stream_handler)

    # Build uvicorn config dict based on use_rotation
    if use_rotation:
        file_handler_config = {
            "class": "logging.handlers.TimedRotatingFileHandler",
            "filename": str((log_dir / f"{service_name}.log").resolve()),
            "when": "midnight",
            "interval": 1,
            "backupCount": 14,
            "encoding": "utf-8",
            "formatter": "default",
        }
    else:
        file_handler_config = {
            "class": "logging.FileHandler",
            "filename": str((log_dir / f"{service_name}.log").resolve()),
            "mode": "a",
            "encoding": "utf-8",
            "formatter": "default",
        }
    
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "default": {
                "()": "logging.Formatter",
                "fmt": "%(asctime)s | %(levelname)s | %(name)s | %(message)s",
            }
        },
        "handlers": {
            "file": file_handler_config,
            "console": {
                "class": "logging.StreamHandler",
                "formatter": "default",
            },
        },
        "loggers": {
            "": {
                "handlers": ["file", "console"],
                "level": level_name,
            },
            "uvicorn": {
                "handlers": ["file", "console"],
                "level": level_name,
                "propagate": False,
            },
            "uvicorn.error": {
                "handlers": ["file", "console"],
                "level": level_name,
                "propagate": False,
            },
            "uvicorn.access": {
                "handlers": ["file", "console"],
                "level": level_name,
                "propagate": False,
            },
        },
    }


def add_request_logging(app: FastAPI, service_name: str) -> None:
    logger = logging.getLogger(service_name)

    @app.middleware("http")
    async def request_logger(request: Request, call_next):
        request_id = uuid.uuid4().hex
        request.state.request_id = request_id
        start = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception as exc:
            elapsed_ms = int((time.perf_counter() - start) * 1000)
            client_ip = request.client.host if request.client else "-"
            logger.exception(
                "request_id=%s method=%s path=%s status=500 latency_ms=%s client_ip=%s error=%s",
                request_id,
                request.method,
                request.url.path,
                elapsed_ms,
                client_ip,
                exc,
            )
            return JSONResponse(status_code=500, content={"detail": str(exc)})

        elapsed_ms = int((time.perf_counter() - start) * 1000)
        client_ip = request.client.host if request.client else "-"
        logger.info(
            "request_id=%s method=%s path=%s status=%s latency_ms=%s client_ip=%s",
            request_id,
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
            client_ip,
        )
        response.headers["X-Request-ID"] = request_id
        return response
