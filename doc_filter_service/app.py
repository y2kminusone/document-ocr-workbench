from __future__ import annotations

from fastapi import FastAPI

from .controllers.filter import lifespan, router
from core.logging import add_request_logging


def create_app() -> FastAPI:
    app = FastAPI(title="Document Filter Server", version="1.0.0", lifespan=lifespan)
    app.include_router(router)
    add_request_logging(app, "doc_filter")
    return app
