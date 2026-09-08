from __future__ import annotations

from typing import Any, Dict, List

from fastapi import HTTPException

from core import ocr_db


def load_cfg() -> ocr_db.DBConfig:
    cfg = ocr_db.load_db_config()
    cfg.database = __import__("os").getenv("DB_NAME", "ocr_portfolio")
    return cfg


def save_cfg(payload) -> ocr_db.DBConfig:
    cfg = ocr_db.DBConfig(
        host=payload.host,
        port=int(payload.port),
        user=payload.user,
        password=payload.password,
        database=__import__("os").getenv("DB_NAME", "ocr_portfolio"),
        table_name=payload.table_name or "ocr_results",
    )
    ocr_db.save_db_config(cfg)
    return cfg


def list_tables(conn) -> List[str]:
    with conn.cursor() as cur:
        cur.execute("SHOW TABLES")
        rows = cur.fetchall() or []
    out: List[str] = []
    for row in rows:
        if isinstance(row, dict) and row:
            out.append(list(row.values())[0])
    out = [t for t in out if not str(t).endswith("__rows")]
    return sorted(out)


def safe_table(table_name: str, allowed: List[str]) -> str:
    if not table_name or table_name not in allowed:
        raise HTTPException(status_code=400, detail="invalid table")
    return table_name


def list_db_columns(conn, table_name: str) -> List[str]:
    with conn.cursor() as cur:
        cur.execute(f"SHOW COLUMNS FROM `{table_name}`")
        rows = cur.fetchall() or []
    cols: List[str] = []
    for row in rows:
        if isinstance(row, dict):
            field = row.get("Field")
            if field:
                cols.append(str(field))
        else:
            try:
                cols.append(str(row[0]))
            except Exception:
                pass
    return cols


def find_existing_doc_ids(conn, table_name: str, title: str, image_name: str) -> List[int]:
    return ocr_db.find_existing_doc_ids(
        conn,
        table_name=table_name,
        title=title,
        image_name=image_name,
    )


def save_ocr_wide_rows(
    conn,
    result: Dict[str, Any],
    image_path: str,
    table_name: str,
    doc_key: str,
    *,
    job_id: str | None = None,
    page_no: int | None = None,
    upsert_strategy: str = "update",
) -> int:
    return int(
        ocr_db.save_ocr_wide_rows(
            conn,
            result,
            image_path=image_path,
            table_name=table_name,
            doc_key=doc_key,
            job_id=job_id,
            page_no=page_no,
            upsert_strategy=upsert_strategy,
        )
    )


def ensure_dynamic_columns(conn, table_name: str, wanted: List[str]) -> Dict[str, str]:
    return ocr_db.ensure_dynamic_columns(conn, table_name, wanted)


def delete_doc_ids(conn, table_name: str, ids: List[int]) -> None:
    ocr_db.delete_doc_ids(conn, table_name=table_name, ids=ids)


def delete_job(conn, job_id: str) -> int:
    """
    특정 job 삭제
    
    Args:
        conn: DB connection
        job_id: Job ID
    
    Returns:
        삭제된 행 수
    """
    with conn.cursor() as cur:
        affected = cur.execute(
            """
            DELETE FROM jobs
            WHERE job_id=%s
            """,
            (job_id,),
        )
    conn.commit()
    return int(affected or 0)


def delete_files_by_job_id(conn, job_id: str) -> int:
    """
    특정 job_id를 가진 모든 파일 삭제
    
    Args:
        conn: DB connection
        job_id: Job ID
    
    Returns:
        삭제된 행 수
    """
    with conn.cursor() as cur:
        affected = cur.execute(
            """
            DELETE FROM files
            WHERE job_id=%s
            """,
            (job_id,),
        )
    conn.commit()
    return int(affected or 0)

