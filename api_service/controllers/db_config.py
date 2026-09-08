from __future__ import annotations

from fastapi import APIRouter

from ..models import DBConfigPayload
from ..repositories import db_repo

router = APIRouter()


@router.get("/api/db_config")
async def get_db_config():
    cfg = db_repo.load_cfg()
    return {
        "host": cfg.host,
        "port": int(cfg.port),
        "user": cfg.user,
        "password": cfg.password,
        "database": cfg.database,
        "table_name": cfg.table_name,
    }


@router.post("/api/db_config")
async def set_db_config(payload: DBConfigPayload):
    cfg = db_repo.save_cfg(payload)
    return {"ok": True, "database": cfg.database, "table_name": cfg.table_name}
