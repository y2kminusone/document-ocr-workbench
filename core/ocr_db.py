import json
import os
import threading
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
import re


_SCHEMA_LOCK = threading.RLock()
_ENSURED_SCHEMAS: set[Tuple[str, str]] = set()


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return default


def _schema_cache_key(conn, table_name: str) -> Tuple[str, str]:
    db = getattr(conn, "db", "") or ""
    if isinstance(db, bytes):
        db = db.decode("utf-8", errors="ignore")
    host = str(getattr(conn, "host", "") or "")
    port = str(getattr(conn, "port", "") or "")
    return (f"{host}:{port}/{db}", str(table_name))


def _is_missing_table_error(exc: Exception) -> bool:
    try:
        return int(getattr(exc, "args", [None])[0]) == 1146
    except Exception:
        return False


def _configure_session(conn) -> None:
    lock_wait_timeout = max(1, _env_int("OCR_DB_LOCK_WAIT_TIMEOUT", 5))
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"SET SESSION lock_wait_timeout={lock_wait_timeout}, "
                f"innodb_lock_wait_timeout={lock_wait_timeout}"
            )
    except Exception:
        pass


@dataclass
class DBConfig:
    host: str = os.getenv("DB_HOST", "127.0.0.1")
    port: int = int(os.getenv("DB_PORT", "3306"))
    user: str = os.getenv("DB_USER", "ocr_user")
    password: str = os.getenv("DB_PASSWORD", "")
    database: str = os.getenv("DB_NAME", "ocr_portfolio")  # 고정값
    table_name: str = "ocr_results"


def _config_path(path: Optional[str] = None) -> str:
    if path:
        return path
    return os.path.join(os.path.dirname(__file__), "db_config.json")


def load_db_config(path: Optional[str] = None) -> DBConfig:
    p = _config_path(path)
    if not os.path.exists(p):
        return DBConfig()
    try:
        with open(p, "r", encoding="utf-8") as f:
            raw = json.load(f) or {}
        cfg = DBConfig()
        for k, v in raw.items():
            if hasattr(cfg, k):
                setattr(cfg, k, v)
        return cfg
    except Exception:
        # 설정 파일이 깨져도 앱이 죽지 않게 기본값 사용
        return DBConfig()


def save_db_config(cfg: DBConfig, path: Optional[str] = None) -> None:
    p = _config_path(path)
    data = {
        "host": cfg.host,
        "port": int(cfg.port),
        "user": cfg.user,
        "password": cfg.password,
        "database": cfg.database,
        "table_name": cfg.table_name,
    }
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _import_pymysql():
    try:
        import pymysql  # type: ignore
        return pymysql
    except Exception as e:
        raise RuntimeError(
            "pymysql 패키지가 필요합니다. 먼저 `pip install pymysql` 를 실행하세요."
        ) from e


def connect(cfg: DBConfig):
    pymysql = _import_pymysql()
    if not cfg.user or not cfg.database:
        raise ValueError("DB user/database 설정이 비어있습니다.")
    conn = pymysql.connect(
        host=cfg.host,
        port=int(cfg.port),
        user=cfg.user,
        password=cfg.password,
        database=cfg.database,
        charset="utf8mb4",
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=max(1, _env_int("OCR_DB_CONNECT_TIMEOUT", 3)),
        read_timeout=max(1, _env_int("OCR_DB_READ_TIMEOUT", 10)),
        write_timeout=max(1, _env_int("OCR_DB_WRITE_TIMEOUT", 10)),
    )
    _configure_session(conn)
    return conn


def ensure_schema(conn, table_name: str = "ocr_results") -> None:
    cache_key = _schema_cache_key(conn, table_name)
    if cache_key in _ENSURED_SCHEMAS:
        return

    with _SCHEMA_LOCK:
        if cache_key in _ENSURED_SCHEMAS:
            return
        _ensure_schema_uncached(conn, table_name=table_name)
        _ENSURED_SCHEMAS.add(cache_key)


def _ensure_schema_uncached(conn, table_name: str = "ocr_results") -> None:
    """
    Wide(행 단위) 저장용 스키마.
    - 문서 1개(OCR 결과 테이블의 각 행)를 DB 1행으로 저장한다.
    - table_data(JSON) 컬럼은 사용하지 않는다.

    기존에 JSON 스키마로 만들어진 테이블이 있어도, 필수 컬럼이 없으면 ADD COLUMN으로 보강한다.
    """
    create_sql = f"""
    CREATE TABLE IF NOT EXISTS `{table_name}` (
      `id` BIGINT NOT NULL AUTO_INCREMENT,
      `doc_key` VARCHAR(255) NOT NULL,
      `image_name` VARCHAR(255) NOT NULL,
      `image_path` VARCHAR(500) NULL,
      `title` VARCHAR(255) NULL,
      `job_id` VARCHAR(64) NULL,
      `page_no` INT NULL,
      `row_index` INT NULL,
      `spool_tag_no` VARCHAR(100) NULL,
      `heat_no` VARCHAR(100) NULL,
      `hcn` VARCHAR(100) NULL,
      `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`),
      UNIQUE KEY `uq_job_page_row` (`job_id`, `page_no`, `row_index`),
      KEY `idx_doc_key` (`doc_key`),
      KEY `idx_image_name` (`image_name`),
      KEY `idx_job_page` (`job_id`, `page_no`),
      KEY `idx_spool_tag_no` (`spool_tag_no`),
      KEY `idx_heat_no` (`heat_no`),
      KEY `idx_hcn` (`hcn`),
      KEY `idx_created_at` (`created_at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    """

    with conn.cursor() as cur:
        cur.execute(create_sql)

    # 기존 테이블(legacy JSON 스키마 등) 보강
    required_cols = {
        "doc_key": "VARCHAR(255) NOT NULL",
        "job_id": "VARCHAR(64) NULL",
        "page_no": "INT NULL",
        "row_index": "INT NULL",
        "spool_tag_no": "VARCHAR(100) NULL",
        "heat_no": "VARCHAR(100) NULL",
        "hcn": "VARCHAR(100) NULL",
    }
    existing = set(c.lower() for c in _get_table_columns(conn, table_name))
    with conn.cursor() as cur:
        for col, ddl in required_cols.items():
            if col.lower() not in existing:
                cur.execute(f"ALTER TABLE `{table_name}` ADD COLUMN `{col}` {ddl}")

    with conn.cursor() as cur:
        cur.execute(f"SHOW INDEX FROM `{table_name}` WHERE Key_name='uq_job_page_row'")
        uniq = cur.fetchall() or []
        if not uniq:
            try:
                cur.execute(
                    f"ALTER TABLE `{table_name}` ADD UNIQUE KEY `uq_job_page_row` (`job_id`, `page_no`, `row_index`)"
                )
            except Exception:
                pass


def _rows_table_name(table_name: str) -> str:
    return f"{table_name}__rows"


def _sanitize_sql_column(name: str) -> str:
    """
    MySQL 컬럼명으로 쓸 수 있게 정규화.
    - 공백/슬래시 등은 '_'로
    - 영숫자/언더스코어만 허용
    - 숫자로 시작하면 'c_' prefix
    - 길이 64 제한
    """
    s = (name or "").strip()
    if not s:
        s = "col"
    s = s.replace("/", "_").replace("\\", "_").replace(" ", "_")
    s = re.sub(r"[^0-9a-zA-Z_]", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    if not s:
        s = "col"
    if s[0].isdigit():
        s = "c_" + s
    if len(s) > 64:
        s = s[:64]
    return s


def _history_table_name(table_name: str) -> str:
    return "history_table"


def load_doc_rows(conn, table_name: str, doc_key: str) -> List[Dict[str, Any]]:
    """
    doc_key 기준으로 기존 저장된 행들을 조회한다.
    """
    dk = (doc_key or "").strip()
    if not dk:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT *
                FROM `{table_name}`
                WHERE doc_key=%s
                ORDER BY row_index ASC, id ASC
                """,
                (dk,),
            )
            rows = cur.fetchall() or []
    except Exception as exc:
        if _is_missing_table_error(exc):
            return []
        raise
    return [r for r in rows if isinstance(r, dict)]


def _normalize_cell_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    return str(value)


def canonicalize_field_name(field_name: Any) -> str:
    raw = str(field_name or "").strip()
    if not raw:
        return ""
    nk = _norm_key(raw)
    compact = nk.replace(" ", "")
    if nk in {"heat no", "heat number", "raw heat no", "heat no raw"}:
        return "heat_no"
    if compact in {"heatno", "rawheatno", "heatnoraw"}:
        return "heat_no"
    return raw


def _canonicalize_row_fields(row: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not isinstance(row, dict):
        return out
    for key, value in row.items():
        ckey = canonicalize_field_name(key)
        if not ckey:
            continue
        current = out.get(ckey)
        if ckey not in out or current in (None, ""):
            out[ckey] = value
    return out


def build_cell_diffs(
    old_rows: List[Dict[str, Any]],
    new_rows: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    행/셀 단위 diff를 생성한다.
    - old_rows/new_rows는 row_index 기준으로 비교한다.
    - 반환 항목: row_index, field_name, old_value, new_value, action
    - 필드명은 원본 그대로 유지 (정규화하지 않음)
    """
    diffs: List[Dict[str, Any]] = []
    skip_cols = {
        "id",
        "created_at",
        "doc_key",
        "image_name",
        "image_path",
        "title",
        "row_index",
    }

    old_by_index: Dict[int, Dict[str, Any]] = {}
    for row in old_rows:
        try:
            idx = int(row.get("row_index", 0))
        except Exception:
            continue
        old_by_index[idx] = dict(row)

    new_by_index: Dict[int, Dict[str, Any]] = {}
    for idx, row in enumerate(new_rows):
        if not isinstance(row, dict):
            continue
        new_by_index[int(idx)] = dict(row)

    all_indexes = sorted(set(old_by_index.keys()) | set(new_by_index.keys()))
    for idx in all_indexes:
        old_row = old_by_index.get(idx)
        new_row = new_by_index.get(idx)
        if old_row is None and new_row is not None:
            for key, value in new_row.items():
                if key is None:
                    continue
                field = str(key).strip()
                if not field or field.lower() in skip_cols:
                    continue
                diffs.append(
                    {
                        "row_index": idx,
                        "field_name": field,
                        "old_value": None,
                        "new_value": _normalize_cell_value(value),
                        "action": "insert",
                    }
                )
            continue
        if old_row is not None and new_row is None:
            for key, value in old_row.items():
                if key is None:
                    continue
                field = str(key).strip()
                if not field or field.lower() in skip_cols:
                    continue
                diffs.append(
                    {
                        "row_index": idx,
                        "field_name": field,
                        "old_value": _normalize_cell_value(value),
                        "new_value": None,
                        "action": "delete",
                    }
                )
            continue

        if old_row is None or new_row is None:
            continue

        for key, value in new_row.items():
            if key is None:
                continue
            field = str(key).strip()
            if not field or field.lower() in skip_cols:
                continue
            old_value = _normalize_cell_value(old_row.get(key))
            new_value = _normalize_cell_value(value)
            if old_value == new_value:
                continue
            diffs.append(
                {
                    "row_index": idx,
                    "field_name": field,
                    "old_value": old_value,
                    "new_value": new_value,
                    "action": "update",
                }
            )

    return diffs


def save_edit_history(
    conn,
    doc_key: str,
    diffs: List[Dict[str, Any]],
    user_id: Optional[str] = None,
) -> int:
    """
    table_name 없이, doc_key 기반으로 history_table에 diff 저장
    """
    if not diffs or not doc_key:
        return 0

    sql = """
    INSERT INTO history_table 
      (doc_key, row_index, field_name, old_value, new_value, action, user_id)
    VALUES (%s, %s, %s, %s, %s, %s, %s)
    """
    inserted = 0
    with conn.cursor() as cur:
        for diff in diffs:
            cur.execute(
                sql,
                (
                    doc_key,
                    int(diff.get("row_index", 0)),
                    str(diff.get("field_name", "")),
                    diff.get("old_value"),
                    diff.get("new_value"),
                    str(diff.get("action", "update")),
                    user_id,
                ),
            )
            inserted += 1
    conn.commit()
    return inserted



def fetch_edit_history(
    conn,
    table_name: str,
    doc_key: str,
    limit: int = 200,
    offset: int = 0,
    row_index: Optional[int] = None,
) -> List[Dict[str, Any]]:
    history_table = _history_table_name(table_name)
    dk = (doc_key or "").strip()
    if not dk:
        return []
    lim = max(1, min(int(limit), 500))
    off = max(0, int(offset))
    clauses = ["doc_key=%s"]
    params: List[Any] = [dk]
    if row_index is not None:
        clauses.append("row_index=%s")
        params.append(int(row_index))
    where = " AND ".join(clauses)
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT *
            FROM `{history_table}`
            WHERE {where}
            ORDER BY created_at DESC, id DESC
            LIMIT %s OFFSET %s
            """,
            params + [lim, off],
        )
        rows = cur.fetchall() or []
    out: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        copied = dict(row)
        copied["field_name"] = canonicalize_field_name(copied.get("field_name"))
        out.append(copied)
    return out


def fetch_history_versions(
    conn,
    doc_key: str,
    limit: int = 50,
    offset: int = 0,
) -> List[Dict[str, Any]]:
    dk = (doc_key or "").strip()
    if not dk:
        return []
    lim = max(1, min(int(limit), 200))
    off = max(0, int(offset))
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              MAX(id) AS version_id,
              doc_key,
              created_at,
              user_id,
              COUNT(DISTINCT row_index) AS row_count
            FROM `history_table`
            WHERE doc_key=%s
            GROUP BY doc_key, created_at, user_id
            ORDER BY created_at DESC, version_id DESC
            LIMIT %s OFFSET %s
            """,
            (dk, lim, off),
        )
        rows = cur.fetchall() or []
    return [r for r in rows if isinstance(r, dict)]


def fetch_history_snapshot(conn, version_id: int) -> Optional[Dict[str, Any]]:
    vid = int(version_id)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, doc_key, created_at, user_id
            FROM `history_table`
            WHERE id=%s
            """,
            (vid,),
        )
        version = cur.fetchone() or None

    if not isinstance(version, dict):
        return None

    doc_key = str(version.get("doc_key") or "").strip()
    created_at = version.get("created_at")

    # 먼저 해당 시점까지의 history 데이터를 가져옴
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, row_index, field_name, new_value
            FROM `history_table`
            WHERE doc_key=%s
              AND (
                created_at < %s
                OR (created_at = %s AND id <= %s)
              )
            ORDER BY created_at ASC, id ASC
            """,
            (doc_key, created_at, created_at, vid),
        )
        history_rows = cur.fetchall() or []

    # 해당 doc_key의 현재 DB 데이터를 가져와서 hcn과 spool_tag_no를 포함
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT row_index, hcn, spool_tag_no
            FROM `ocr_results`
            WHERE doc_key=%s
            ORDER BY row_index ASC
            """,
            (doc_key,),
        )
        db_rows = cur.fetchall() or []

    # DB 데이터를 row_index별로 매핑
    db_data_by_index: Dict[int, Dict[str, Any]] = {}
    for row in db_rows:
        if not isinstance(row, dict):
            continue
        try:
            idx = int(row.get("row_index", 0))
        except Exception:
            continue
        db_data_by_index[idx] = {
            "hcn": row.get("hcn"),
            "spool_tag_no": row.get("spool_tag_no"),
        }

    rows_by_index: Dict[int, Dict[str, Any]] = {}
    columns_set: set[str] = set()
    for row in history_rows:
        if not isinstance(row, dict):
            continue
        try:
            idx = int(row.get("row_index", 0))
        except Exception:
            continue
        field_name = canonicalize_field_name(row.get("field_name"))
        if not field_name:
            continue
        value = row.get("new_value")
        if idx not in rows_by_index:
            rows_by_index[idx] = {}
        rows_by_index[idx][field_name] = value
        columns_set.add(field_name)

    # hcn과 spool_tag_no를 각 row에 추가
    for idx, data in rows_by_index.items():
        if idx in db_data_by_index:
            db_data = db_data_by_index[idx]
            if db_data.get("hcn"):
                data["hcn"] = db_data["hcn"]
                columns_set.add("hcn")
            if db_data.get("spool_tag_no"):
                data["spool_tag_no"] = db_data["spool_tag_no"]
                columns_set.add("spool_tag_no")

    out_rows: List[Dict[str, Any]] = []
    for idx in sorted(rows_by_index.keys()):
        data = rows_by_index[idx]
        if not any(v not in (None, "") for v in data.values()):
            continue
        rec = {"row_index": idx}
        rec.update(data)
        out_rows.append(rec)

    columns = ["row_index"] + sorted(columns_set)
    return {
        "version_id": vid,
        "doc_key": doc_key,
        "created_at": created_at,
        "user_id": version.get("user_id"),
        "rows": out_rows,
        "columns": columns,
    }

def fetch_rows_for_doc(conn, table_name: str, doc_key: str) -> List[Dict[str, Any]]:
    """
    특정 doc_key를 가진 모든 행을 조회 (diff 비교용)
    """
    if not table_name or not doc_key:
        return []

    query = f"""
        SELECT *
        FROM `{table_name}`
        WHERE doc_key = %s
        ORDER BY COALESCE(row_index, 0)
    """
    try:
        with conn.cursor() as cur:
            cur.execute(query, (doc_key,))
            rows = cur.fetchall() or []
        return [dict(row) for row in rows]
    except Exception as e:
        print(f"[ERROR] Failed to fetch rows: {e}")
        return []




def ensure_rows_schema(conn, table_name: str) -> str:
    """
    OCR 테이블의 '각 행'을 DB의 '각 레코드'로 저장하기 위한 테이블.
    - 실제 데이터 컬럼(예: C, Si, Heat_No 등)은 동적으로 ADD COLUMN 한다.
    """
    rows_table = _rows_table_name(table_name)
    create_sql = f"""
    CREATE TABLE IF NOT EXISTS `{rows_table}` (
      `id` BIGINT NOT NULL AUTO_INCREMENT,
      `doc_key` VARCHAR(255) NOT NULL,
      `image_name` VARCHAR(255) NOT NULL,
      `image_path` VARCHAR(500) NULL,
      `title` VARCHAR(255) NULL,
      `row_index` INT NULL,
      `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`),
      KEY `idx_doc_key` (`doc_key`),
      KEY `idx_image_name` (`image_name`),
      KEY `idx_created_at` (`created_at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    """
    with conn.cursor() as cur:
        cur.execute(create_sql)
    return rows_table


def _get_table_columns(conn, table_name: str) -> List[str]:
    with conn.cursor() as cur:
        cur.execute(f"SHOW COLUMNS FROM `{table_name}`")
        rows = cur.fetchall() or []
    out: List[str] = []
    for r in rows:
        if isinstance(r, dict):
            # Field 컬럼
            v = r.get("Field")
            if v:
                out.append(str(v))
        else:
            # tuple 형태일 수도 있음: (Field, Type, Null, Key, Default, Extra)
            try:
                out.append(str(r[0]))
            except Exception:
                pass
    return out


def ensure_dynamic_columns(conn, table_name: str, wanted_columns: List[str]) -> Dict[str, str]:
    """
    wanted_columns(원본 컬럼명)을 sanitize하여 table_name에 컬럼이 없으면 추가.
    반환: {원본컬럼명: 실제DB컬럼명}
    """
    existing = set(c.lower() for c in _get_table_columns(conn, table_name))
    mapping: Dict[str, str] = {}
    to_add: List[str] = []

    # wide 스키마에서 기본으로 쓰는 컬럼들과 충돌 방지
    reserved = {
        "id",
        "doc_key",
        "image_name",
        "image_path",
        "title",
        "row_index",
        "created_at",
        "spool_tag_no",
        "heat_no",
        "hcn",
    }
    used: set[str] = set(x.lower() for x in reserved)

    for raw in wanted_columns:
        db_col = _sanitize_sql_column(str(raw))
        # reserved 충돌 방지
        if db_col.lower() in reserved:
            db_col = f"col_{db_col}"
        base = db_col
        i = 2
        while db_col.lower() in used:
            db_col = f"{base}_{i}"
            i += 1
        used.add(db_col.lower())
        mapping[str(raw)] = db_col
        if db_col.lower() not in existing:
            to_add.append(db_col)
            existing.add(db_col.lower())

    if to_add:
        with conn.cursor() as cur:
            for c in to_add:
                # 값은 숫자/문자 혼재 가능하므로 TEXT로 저장
                cur.execute(f"ALTER TABLE `{table_name}` ADD COLUMN `{c}` TEXT NULL")
    return mapping


def delete_doc_key_rows(conn, *, table_name: str, doc_key: str) -> int:
    rows_table = ensure_rows_schema(conn, table_name=table_name)
    dk = (doc_key or "").strip()
    if not dk:
        return 0
    with conn.cursor() as cur:
        cur.execute(f"DELETE FROM `{rows_table}` WHERE doc_key=%s", (dk,))
        try:
            return int(cur.rowcount)
        except Exception:
            return 0


def save_ocr_rows(
    conn,
    result_data: Dict[str, Any],
    image_path: Optional[str] = None,
    table_name: str = "ocr_results",
) -> int:
    """
    result_data의 table(리스트[dict])를 '행 단위'로 `{table_name}__rows`에 저장한다.
    - JSON 컬럼(table_data)을 쓰지 않는다.
    - 컬럼은 동적으로 확장(ADD COLUMN)한다.
    반환: 삽입된 행(row) 개수
    """
    image_name = (result_data or {}).get("image_name") or (os.path.basename(image_path) if image_path else "unknown")
    title = (result_data or {}).get("title") or ""
    doc_key = (title or "").strip() or (image_name or "").strip() or "알 수 없음"
    table_rows = (result_data or {}).get("table") or []
    columns = (result_data or {}).get("columns") or []

    if not isinstance(table_rows, list):
        return 0
    table_rows = [r for r in table_rows if isinstance(r, dict)]
    if not table_rows:
        return 0

    # columns가 없으면 rows에서 키를 모아 생성
    if not isinstance(columns, list) or not columns:
        col_set: List[str] = []
        seen = set()
        for r in table_rows:
            for k in r.keys():
                ks = str(k)
                if ks not in seen:
                    seen.add(ks)
                    col_set.append(ks)
        columns = col_set
    else:
        columns = [str(c) for c in columns if c is not None and str(c).strip()]

    source_by_canonical: Dict[str, List[str]] = {}
    canonical_columns: List[str] = []
    seen_columns: set[str] = set()
    for raw_col in columns:
        canonical_col = canonicalize_field_name(raw_col)
        if not canonical_col:
            continue
        source_by_canonical.setdefault(canonical_col, []).append(str(raw_col))
        if canonical_col in seen_columns:
            continue
        seen_columns.add(canonical_col)
        canonical_columns.append(canonical_col)
    columns = canonical_columns

    rows_table = ensure_rows_schema(conn, table_name=table_name)
    mapping = ensure_dynamic_columns(conn, rows_table, columns)

    base_cols = ["doc_key", "image_name", "image_path", "title", "row_index"]
    dyn_cols = [mapping[c] for c in columns if c in mapping]
    all_cols = base_cols + dyn_cols
    placeholders = ", ".join(["%s"] * len(all_cols))
    col_sql = ", ".join([f"`{c}`" for c in all_cols])
    sql = f"INSERT INTO `{rows_table}` ({col_sql}) VALUES ({placeholders})"

    inserted = 0
    with conn.cursor() as cur:
        for idx, r in enumerate(table_rows):
            vals: List[Any] = [
                doc_key,
                image_name,
                image_path,
                title,
                int(idx),
            ]
            for canonical_col in columns:
                db_col = mapping.get(str(canonical_col))
                if not db_col:
                    continue
                v = None
                for source_col in source_by_canonical.get(canonical_col, []):
                    if source_col in r and r.get(source_col) not in (None, ""):
                        v = r.get(source_col)
                        break
                if v is None:
                    v = r.get(canonical_col)
                if v is None:
                    vals.append(None)
                else:
                    vals.append(str(v))
            cur.execute(sql, tuple(vals))
            inserted += 1
    return inserted


def _norm_key(s: str) -> str:
    # "Heat No.", "HeatNo", "Heat No / Raw" 등 대응
    t = (s or "").strip().lower()
    for ch in [".", ",", ":", ";", "-", "_", "(", ")", "[", "]", "{", "}", "*", "%", "/"]:
        t = t.replace(ch, " ")
    t = " ".join(t.split())
    return t


def extract_common_fields(table_rows: List[Dict[str, Any]]) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    if not table_rows:
        return None, None, None

    spool_candidates = {"spool tag no", "spool tag", "spooltag", "spool tag number"}
    heat_candidates = {"heat no", "heat number", "heatno", "raw heat no", "raw heatno", "heat no raw"}
    hcn_candidates = {"hcn", "h c n", "hcn.", "h.c.n"}

    spool_val: Optional[str] = None
    heat_val: Optional[str] = None
    hcn_val: Optional[str] = None

    for row in table_rows:
        if not isinstance(row, dict):
            continue
        for k, v in row.items():
            nk = _norm_key(str(k))
            sv = str(v).strip() if v is not None else ""
            if not sv:
                continue

            if spool_val is None and any(c in nk for c in spool_candidates):
                spool_val = sv
            if heat_val is None and any(c in nk for c in heat_candidates):
                heat_val = sv
            if hcn_val is None and any(c in nk for c in hcn_candidates):
                hcn_val = sv

        if spool_val is not None and heat_val is not None and hcn_val is not None:
            break

    return spool_val, heat_val, hcn_val


def _extract_row_fields(row: Dict[str, Any]) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    한 '행'에서 spool_tag_no / heat_no / hcn 값을 추출(있으면).
    """
    if not isinstance(row, dict):
        return None, None, None

    spool_candidates = {"spool tag no", "spool tag", "spooltag", "spool tag number"}
    heat_candidates = {"heat no", "heat number", "heatno", "raw heat no", "raw heatno", "heat no raw"}
    hcn_candidates = {"hcn", "h c n", "hcn.", "h.c.n"}

    spool_val: Optional[str] = None
    heat_val: Optional[str] = None
    hcn_val: Optional[str] = None

    for k, v in row.items():
        nk = _norm_key(str(k))
        sv = str(v).strip() if v is not None else ""
        if not sv:
            continue
        if spool_val is None and any(c in nk for c in spool_candidates):
            spool_val = sv
        if heat_val is None and any(c in nk for c in heat_candidates):
            heat_val = sv
        if hcn_val is None and any(c in nk for c in hcn_candidates):
            hcn_val = sv

    return spool_val, heat_val, hcn_val


def save_ocr_wide_rows(
    conn,
    result_data: Dict[str, Any],
    image_path: Optional[str] = None,
    table_name: str = "ocr_results",
    doc_key: Optional[str] = None,
    job_id: Optional[str] = None,
    page_no: Optional[int] = None,
    upsert_strategy: str = "update",
) -> int:
    """
    result_data의 table(리스트[dict])를 'wide(행 단위)'로 `{table_name}` 자체에 저장한다.
    - table_data(JSON)는 저장하지 않는다.
    - 컬럼은 동적으로 확장(ADD COLUMN)한다.
    반환: 삽입된 행(row) 개수
    """
    image_name = (result_data or {}).get("image_name") or (os.path.basename(image_path) if image_path else "unknown")
    title = (result_data or {}).get("title") or ""
    dk = (doc_key or "").strip() or (title or "").strip() or (image_name or "").strip() or "알 수 없음"
    table_rows = (result_data or {}).get("rows") or (result_data or {}).get("table") or []
    columns = (result_data or {}).get("columns") or []

    if not isinstance(table_rows, list):
        return 0
    # ✅ 모든 dict 타입의 행을 유지 (빈 값이 있어도 저장)
    table_rows = [r for r in table_rows if isinstance(r, dict)]
    if not table_rows:
        return 0

    # columns가 없으면 rows에서 키를 모아 생성
    if not isinstance(columns, list) or not columns:
        col_set: List[str] = []
        seen = set()
        for r in table_rows:
            for k in r.keys():
                ks = str(k)
                if ks not in seen:
                    seen.add(ks)
                    col_set.append(ks)
        columns = col_set
    else:
        columns = [str(c) for c in columns if c is not None and str(c).strip()]

    # heat_no/hcn/spool_tag_no 계열은 base 컬럼으로만 저장하고, 동적 컬럼에는 포함하지 않는다.
    ensure_schema(conn, table_name=table_name)
    dyn_source_cols: List[str] = []
    for c in columns:
        nk = _norm_key(str(c))
        if "heat no" in nk or "heatno" in nk:
            continue
        if "hcn" in nk or nk == "h c n":
            continue
        if "spool tag" in nk or "spooltag" in nk:
            continue
        dyn_source_cols.append(c)

    mapping = ensure_dynamic_columns(conn, table_name, dyn_source_cols)

    base_cols = [
        "doc_key",
        "image_name",
        "image_path",
        "title",
        "job_id",
        "page_no",
        "row_index",
        "spool_tag_no",
        "heat_no",
        "hcn",
    ]
    dyn_cols = [mapping[c] for c in dyn_source_cols if c in mapping]
    all_cols = base_cols + dyn_cols
    placeholders = ", ".join(["%s"] * len(all_cols))
    col_sql = ", ".join([f"`{c}`" for c in all_cols])
    strategy = (upsert_strategy or "update").strip().lower()
    if strategy == "ignore":
        sql = f"INSERT IGNORE INTO `{table_name}` ({col_sql}) VALUES ({placeholders})"
    else:
        update_cols = [c for c in all_cols if c not in ("job_id", "page_no", "row_index")]
        update_sql = ", ".join([f"`{c}`=VALUES(`{c}`)" for c in update_cols])
        sql = f"INSERT INTO `{table_name}` ({col_sql}) VALUES ({placeholders}) ON DUPLICATE KEY UPDATE {update_sql}"

    inserted = 0
    with conn.cursor() as cur:
        for idx, r in enumerate(table_rows):
            spool_tag_no, heat_no, hcn = _extract_row_fields(r)
            vals: List[Any] = [
                dk,
                image_name,
                image_path,
                title,
                str(job_id) if job_id else None,
                int(page_no) if page_no is not None else None,
                int(idx),
                spool_tag_no,
                heat_no,
                hcn,
            ]
            for raw_col in dyn_source_cols:
                db_col = mapping.get(str(raw_col))
                if not db_col:
                    continue
                v = r.get(raw_col)
                # ✅ 빈 문자열("")도 그대로 저장 (None만 제외)
                if v is None:
                    vals.append(None)
                else:
                    vals.append(str(v))
            try:
                cur.execute(sql, tuple(vals))
                inserted += 1
            except Exception as e:
                # 로깅을 위해 에러를 출력하지만 계속 진행
                print(f"[ERROR] Failed to insert row {idx}: {e}")
                print(f"[DEBUG] Row data: {r}")
                print(f"[DEBUG] Values: {vals}")
    return inserted


def find_existing_doc_ids(
    conn,
    *,
    table_name: str,
    title: Optional[str],
    image_name: Optional[str],
) -> List[int]:

    # wide 스키마에서는 문서 키(doc_key)로 존재 여부를 판단한다.
    dk = (title or "").strip()
    img = (image_name or "").strip()
    if dk:
        sql = f"SELECT id FROM `{table_name}` WHERE doc_key = %s ORDER BY created_at DESC, id DESC"
        params = (dk,)
    else:
        sql = f"SELECT id FROM `{table_name}` WHERE image_name = %s ORDER BY created_at DESC, id DESC"
        params = (img,)

    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall() or []
            out: List[int] = []
            for r in rows:
                try:
                    out.append(int((r or {}).get("id")))
                except Exception:
                    continue
            return out
    except Exception as exc:
        if _is_missing_table_error(exc):
            return []
        raise


def find_existing_rows_by_job_page(
    conn,
    *,
    table_name: str,
    job_id: str,
    page_no: int,
) -> List[int]:
    """
    job_id와 page_no 조합으로 기존 레코드 ID들을 찾음
    PDF 페이지의 경우 이 함수를 사용하여 기존 레코드를 찾고 삭제 후 재삽입
    """
    sql = f"""
    SELECT id FROM `{table_name}` 
    WHERE job_id = %s AND page_no = %s 
    ORDER BY row_index ASC
    """
    
    try:
        with conn.cursor() as cur:
            cur.execute(sql, (job_id, page_no))
            rows = cur.fetchall() or []
            out: List[int] = []
            for r in rows:
                try:
                    out.append(int((r or {}).get("id")))
                except Exception:
                    continue
            return out
    except Exception as exc:
        if _is_missing_table_error(exc):
            return []
        raise


def delete_doc_ids(conn, *, table_name: str, ids: List[int]) -> int:
    if not ids:
        return 0
    placeholders = ", ".join(["%s"] * len(ids))
    sql = f"DELETE FROM `{table_name}` WHERE id IN ({placeholders})"
    try:
        with conn.cursor() as cur:
            cur.execute(sql, tuple(int(x) for x in ids))
            try:
                return int(cur.rowcount)
            except Exception:
                return 0
    except Exception as exc:
        if _is_missing_table_error(exc):
            return 0
        raise
