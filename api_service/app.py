from __future__ import annotations

import logging
import time
import uuid

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from .controllers import db, db_config, files, health, jobs, vlm
from .errors import AppError
from .services.jobs_service import recover_expired_page_leases
from .services.runtime_persistence import restore_runtime_state


def create_app() -> FastAPI:
    app = FastAPI(title="OCR API", version="1.0.0")
    logger = logging.getLogger("api")

    @app.middleware("http")
    async def allow_all_cors(request: Request, call_next):
        request_id = uuid.uuid4().hex
        start = time.perf_counter()
        origin = request.headers.get("origin")
        try:
            if request.method == "OPTIONS":
                resp = Response(status_code=204)
            else:
                resp = await call_next(request)
        except HTTPException as exc:
            resp = JSONResponse(status_code=int(exc.status_code), content={"detail": exc.detail})
        except AppError as exc:
            resp = JSONResponse(status_code=int(exc.status_code), content=exc.to_dict())
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
            resp = JSONResponse(status_code=500, content={"detail": str(exc)})

        allow_origin = origin if origin is not None else "*"
        resp.headers["Access-Control-Allow-Origin"] = allow_origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS"
        req_headers = request.headers.get("access-control-request-headers")
        resp.headers["Access-Control-Allow-Headers"] = req_headers or "*"
        resp.headers["Access-Control-Max-Age"] = "86400"
        resp.headers["X-Request-ID"] = request_id

        elapsed_ms = int((time.perf_counter() - start) * 1000)
        client_ip = request.client.host if request.client else "-"
        logger.info(
            "request_id=%s method=%s path=%s status=%s latency_ms=%s client_ip=%s",
            request_id,
            request.method,
            request.url.path,
            resp.status_code,
            elapsed_ms,
            client_ip,
        )
        return resp

    @app.on_event("startup")
    async def startup_recover_job_pages() -> None:
        restored = restore_runtime_state()
        logger.info(
            "restored_runtime_state jobs=%s files=%s parse_failed=%s",
            restored.get("jobs", 0),
            restored.get("files", 0),
            restored.get("parse_failed", 0),
        )
        if int(restored.get("parse_failed", 0) or 0) > 0:
            logger.warning("runtime_restore_parse_failed=%s", restored.get("parse_failed", 0))


        recovered = recover_expired_page_leases()
        if recovered > 0:
            logger.info("recovered_expired_job_pages=%s", recovered)


    app.include_router(health.router)
    app.include_router(db_config.router)
    app.include_router(jobs.router)
    app.include_router(files.router)
    app.include_router(db.router)
    # ==================== VLM 디자인 패턴 관련 코드 주석 처리 ====================
    # app.include_router(vlm.router)
    # ============================================================

    return app
