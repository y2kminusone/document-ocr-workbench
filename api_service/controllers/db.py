from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException

from core import ocr_db

from ..models import DBRowUpdatePayload
from ..repositories import db_repo
from .. import state
from ..services.runtime_persistence import persist_runtime_manifests

router = APIRouter()


@router.get("/api/db/tables")
async def db_tables():
    cfg = db_repo.load_cfg()
    conn = ocr_db.connect(cfg)
    try:
        return {"tables": db_repo.list_tables(conn)}
    finally:
        try:
            conn.close()
        except Exception:
            pass


@router.get("/api/db/{table_name}/rows")
async def db_rows(
    table_name: str,
    limit: int = 50,
    offset: int = 0,
    q: str = "",
    table_q: str = "",
):
    cfg = db_repo.load_cfg()
    conn = ocr_db.connect(cfg)
    try:
        allowed = db_repo.list_tables(conn)
        table = db_repo.safe_table(table_name, allowed)

        clauses: List[str] = []
        params: List[Any] = []
        if q.strip():
            clauses.append("(title LIKE %s OR image_name LIKE %s)")
            params.append(f"%{q.strip()}%")
            params.append(f"%{q.strip()}%")
        if table_q.strip():
            cols = db_repo.list_db_columns(conn, table)
            skip = {"id", "created_at"}
            like_cols = [c for c in cols if c and c.lower() not in skip]
            if like_cols:
                sub = " OR ".join([f"CAST(`{c}` AS CHAR) LIKE %s" for c in like_cols])
                clauses.append("(" + sub + ")")
                params.extend([f"%{table_q.strip()}%"] * len(like_cols))

        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        lim = max(1, min(int(limit), 200))
        off = max(0, int(offset))

        with conn.cursor() as cur:
            cur.execute(f"SELECT COUNT(*) AS cnt FROM `{table}` {where}", params)
            total = int((cur.fetchone() or {}).get("cnt", 0) or 0)
            cur.execute(
                f"""
                SELECT id, created_at, image_name, title
                FROM `{table}` {where}
                ORDER BY created_at DESC, id DESC
                LIMIT %s OFFSET %s
                """,
                params + [lim, off],
            )
            rows = cur.fetchall() or []

        return {"total": total, "limit": lim, "offset": off, "rows": rows}
    finally:
        try:
            conn.close()
        except Exception:
            pass


@router.get("/api/db/{table_name}/docs")
async def db_docs(
    table_name: str,
    limit: int = 50,
    offset: int = 0,
    q: str = "",
    table_q: str = "",
):
    cfg = db_repo.load_cfg()
    conn = ocr_db.connect(cfg)
    try:
        allowed = db_repo.list_tables(conn)
        table = db_repo.safe_table(table_name, allowed)

        clauses: List[str] = []
        params: List[Any] = []
        if q.strip():
            clauses.append("(doc_key LIKE %s OR title LIKE %s OR image_name LIKE %s)")
            params.append(f"%{q.strip()}%")
            params.append(f"%{q.strip()}%")
            params.append(f"%{q.strip()}%")
        if table_q.strip():
            cols = db_repo.list_db_columns(conn, table)
            skip = {"id", "created_at"}
            like_cols = [c for c in cols if c and c.lower() not in skip]
            if like_cols:
                sub = " OR ".join([f"CAST(`{c}` AS CHAR) LIKE %s" for c in like_cols])
                clauses.append("(" + sub + ")")
                params.extend([f"%{table_q.strip()}%"] * len(like_cols))

        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        lim = max(1, min(int(limit), 200))
        off = max(0, int(offset))

        with conn.cursor() as cur:
            cur.execute(f"SELECT COUNT(DISTINCT doc_key) AS cnt FROM `{table}` {where}", params)
            total = int((cur.fetchone() or {}).get("cnt", 0) or 0)
            cur.execute(
                f"""
                SELECT
                  doc_key,
                  MAX(created_at) AS created_at,
                  MAX(image_name) AS image_name,
                  MAX(title) AS title,
                  COUNT(*) AS rows_count
                FROM `{table}` {where}
                GROUP BY doc_key
                ORDER BY created_at DESC
                LIMIT %s OFFSET %s
                """,
                params + [lim, off],
            )
            docs = cur.fetchall() or []

        return {"total": total, "limit": lim, "offset": off, "docs": docs}
    finally:
        try:
            conn.close()
        except Exception:
            pass


@router.get("/api/db/{table_name}/doc/{doc_key}/rows")
async def db_doc_rows(table_name: str, doc_key: str):
    cfg = db_repo.load_cfg()
    conn = ocr_db.connect(cfg)
    try:
        allowed = db_repo.list_tables(conn)
        table = db_repo.safe_table(table_name, allowed)
        dk = (doc_key or "").strip()
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT *
                FROM `{table}`
                WHERE doc_key=%s
                ORDER BY row_index ASC, id ASC
                """,
                (dk,),
            )
            rows = cur.fetchall() or []
        
        # 컬럼 순서 정보 추가
        columns = db_repo.list_db_columns(conn, table)
        
        return {"doc_key": dk, "rows": rows, "columns": columns}
    finally:
        try:
            conn.close()
        except Exception:
            pass


@router.get("/api/db/doc/{doc_key}/history")
async def db_doc_history(
    doc_key: str,
    limit: int = 200,
    offset: int = 0,
    row_index: Optional[int] = None,
):
    cfg = db_repo.load_cfg()
    conn = ocr_db.connect(cfg)
    try:
        history = ocr_db.fetch_edit_history(
            conn,
            table_name="history_table",
            doc_key=doc_key,
            limit=limit,
            offset=offset,
            row_index=row_index,
        )
        return {
            "doc_key": doc_key,
            "history": history,
            "deprecated": True,
            "message": "Use /api/db/doc/{doc_key}/history/versions and /api/db/history/version/{version_id}",
        }
    finally:
        conn.close()


@router.get("/api/db/doc/{doc_key}/history/versions")
async def db_doc_history_versions(doc_key: str, limit: int = 50, offset: int = 0):
    cfg = db_repo.load_cfg()
    conn = ocr_db.connect(cfg)
    try:
        lim = max(1, min(int(limit), 200))
        off = max(0, int(offset))
        versions = ocr_db.fetch_history_versions(conn, doc_key=doc_key, limit=lim, offset=off)
        return {"doc_key": doc_key, "versions": versions, "limit": lim, "offset": off}
    finally:
        conn.close()


@router.get("/api/db/history/version/{version_id}")
async def db_history_version_snapshot(version_id: int):
    cfg = db_repo.load_cfg()
    conn = ocr_db.connect(cfg)
    try:
        snapshot = ocr_db.fetch_history_snapshot(conn, version_id=version_id)
        if not snapshot:
            raise HTTPException(status_code=404, detail="version not found")
        return snapshot
    finally:
        conn.close()


@router.get("/api/db/{table_name}/row/{row_id}")
async def db_row_detail(table_name: str, row_id: int):
    cfg = db_repo.load_cfg()
    conn = ocr_db.connect(cfg)
    try:
        allowed = db_repo.list_tables(conn)
        table = db_repo.safe_table(table_name, allowed)
        rid = int(row_id)
        with conn.cursor() as cur:
            cur.execute(f"SELECT * FROM `{table}` WHERE id=%s", (rid,))
            row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="not found")
        return {"row": row}
    finally:
        try:
            conn.close()
        except Exception:
            pass


@router.put("/api/db/{table_name}/row/{row_id}")
async def db_row_update(table_name: str, row_id: int, payload: DBRowUpdatePayload):
    cfg = db_repo.load_cfg()
    conn = ocr_db.connect(cfg)
    try:
        allowed = db_repo.list_tables(conn)
        table = db_repo.safe_table(table_name, allowed)
        rid = int(row_id)

        # 1. 수정 전 데이터 조회 (수정이력용)
        with conn.cursor() as cur:
            cur.execute(f"SELECT * FROM `{table}` WHERE id=%s", (rid,))
            old_row = cur.fetchone()

        updates: List[str] = []
        params: List[Any] = []

        if payload.title is not None:
            updates.append("title=%s")
            params.append(payload.title)
        if payload.data:
            existing_cols = db_repo.list_db_columns(conn, table)
            by_lower = {str(c).lower(): str(c) for c in existing_cols if c}

            wanted: List[str] = []
            for key in payload.data.keys():
                if key is None:
                    continue
                key_str = str(key).strip()
                if not key_str:
                    continue
                if key_str.lower() in by_lower:
                    continue
                wanted.append(key_str)

            try:
                mapping = db_repo.ensure_dynamic_columns(conn, table, wanted) if wanted else {}
            except Exception:
                mapping = {str(k): str(k) for k in wanted}

            for raw_key, value in payload.data.items():
                if raw_key is None:
                    continue
                raw = str(raw_key).strip()
                if not raw:
                    continue
                if raw.lower() in {"id", "created_at"}:
                    continue

                col = by_lower.get(raw.lower()) or mapping.get(raw) or raw
                updates.append(f"`{col}`=%s")
                params.append(None if value is None else str(value))

        if not updates:
            return {"ok": True}

        params.append(rid)
        with conn.cursor() as cur:
            cur.execute(f"UPDATE `{table}` SET {', '.join(updates)} WHERE id=%s", params)

        # 2. 수정 후 데이터 조회 (수정이력용)
        with conn.cursor() as cur:
            cur.execute(f"SELECT * FROM `{table}` WHERE id=%s", (rid,))
            new_row = cur.fetchone()

        # 3. 수정이력 저장
        if old_row and new_row:
            diffs = ocr_db.build_cell_diffs([old_row], [new_row])
            if diffs:
                doc_key = old_row.get("doc_key") or new_row.get("doc_key")
                if doc_key:
                    ocr_db.save_edit_history(conn, doc_key, diffs, user_id="unknown")

        # 4. JSON 파일 동기화 제거
        # 하이브리드 방식: DB가 단일 진실 공급원이므로 files.json 동기화 불필요
        # OCR 화면에서 파일을 선택할 때 DB에서 데이터를 조회하므로 동기화 필요 없음
        # 이로 인해 persist_runtime_manifests() 실패 시 데이터 불일치 문제 해결

        return {"ok": True}
    finally:
        try:
            conn.close()
        except Exception:
            pass


@router.delete("/api/db/{table_name}/row/{row_id}")
async def db_row_delete(table_name: str, row_id: int):
    cfg = db_repo.load_cfg()
    conn = ocr_db.connect(cfg)
    try:
        allowed = db_repo.list_tables(conn)
        table = db_repo.safe_table(table_name, allowed)
        rid = int(row_id)
        with conn.cursor() as cur:
            cur.execute(f"DELETE FROM `{table}` WHERE id=%s", (rid,))
        return {"ok": True}
    finally:
        try:
            conn.close()
        except Exception:
            pass


@router.delete("/api/db/{table_name}/doc/{doc_key}")
async def db_doc_delete(table_name: str, doc_key: str):
    cfg = db_repo.load_cfg()
    conn = ocr_db.connect(cfg)
    try:
        allowed = db_repo.list_tables(conn)
        table = db_repo.safe_table(table_name, allowed)
        dk = (doc_key or "").strip()
        if not dk:
            raise HTTPException(status_code=400, detail="doc_key is required")
        
        with conn.cursor() as cur:
            cur.execute(f"DELETE FROM `{table}` WHERE doc_key=%s", (dk,))
            deleted_count = cur.rowcount
        
        return {"ok": True, "deleted_count": deleted_count}
    finally:
        try:
            conn.close()
        except Exception:
            pass


@router.post("/api/system/clear-runtime")
async def clear_runtime_state():
    """
    런타임 상태 초기화 (서버 재시작 없음)
    - 메모리 상의 JOBS, FILES, FILE_SOURCE_INDEX 초기화
    - 매니페스트 파일 (jobs.json, files.json) 삭제
    """
    try:
        # 메모리 상태 초기화
        jobs_count = len(state.JOBS)
        files_count = len(state.FILES)
        
        state.JOBS.clear()
        state.FILES.clear()
        state.FILE_SOURCE_INDEX.clear()
        
        # 매니페스트 파일 삭제
        from .. import config
        import os
        
        jobs_manifest = config.JOBS_MANIFEST_PATH
        files_manifest = config.FILES_MANIFEST_PATH
        
        if jobs_manifest.exists():
            os.remove(jobs_manifest)
        
        if files_manifest.exists():
            os.remove(files_manifest)
        
        return {
            "ok": True,
            "message": "Runtime state cleared successfully",
            "cleared_jobs": jobs_count,
            "cleared_files": files_count,
            "manifests_deleted": True
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to clear runtime state: {str(e)}")
