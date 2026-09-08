from __future__ import annotations

from fastapi import FastAPI

from .controllers.detect import lifespan, router
from core.logging import add_request_logging


def create_app() -> FastAPI:
    app = FastAPI(title="YOLO Detection Server", version="1.0.0", lifespan=lifespan)
    app.include_router(router)
    add_request_logging(app, "yolo")
    return app
