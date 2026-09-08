from __future__ import annotations

from fastapi import FastAPI

from .controllers.process import router
from core.logging import add_request_logging


def create_app() -> FastAPI:
    app = FastAPI(title="OCR Processor Server", version="1.0.0")
    app.include_router(router)
    add_request_logging(app, "ocr")
    return app
