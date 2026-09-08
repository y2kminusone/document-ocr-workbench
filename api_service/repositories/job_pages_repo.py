from __future__ import annotations

import time
from typing import Any, Dict, Optional

from core import ocr_db

_CONNECT_RETRY = 3
_CONNECT_BACKOFF_SEC = 0.3


def _load_cfg() -> ocr_db.DBConfig:
    cfg = ocr_db.load_db_config()
    cfg.database = __import__("os").getenv("DB_NAME", "ocr_portfolio")
    return cfg


def _connect():
    last_exc: Optional[Exception] = None
    for i in range(_CONNECT_RETRY):
        try:
            return ocr_db.connect(_load_cfg())
        except Exception as exc:
            last_exc = exc
            if i < (_CONNECT_RETRY - 1):
                time.sleep(_CONNECT_BACKOFF_SEC)
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("job_pages DB 연결에 실패했습니다.")


def _row_get(row: Any, key: str, idx: int) -> Any:
    if row is None:
        return None
    if isinstance(row, dict):
        return row.get(key)
    try:
        return row[idx]
    except Exception:
        return None


def init_job_pages_table() -> None:
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS job_pages (
                    job_id VARCHAR(64) NOT NULL,
                    page_index INT NOT NULL,
                    status ENUM('queued','processing','done','error','cancelled') NOT NULL,
                    attempt INT NOT NULL DEFAULT 0,
                    is_interest TINYINT(1) NULL,
                    file_id VARCHAR(64) NULL,
                    last_error TEXT NULL,
                    lease_until BIGINT NULL,
                    created_ms BIGINT NOT NULL,
                    updated_ms BIGINT NOT NULL,
                    classification_status VARCHAR(20) DEFAULT 'queued',
                    PRIMARY KEY (job_id, page_index),
                    KEY idx_job_pages_pick (job_id, status, page_index),
                    KEY idx_job_pages_lease (status, lease_until)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """
            )
        conn.commit()
    finally:
        conn.close()


def enqueue_job_pages(job_id: str, total_pages: int) -> None:
    total = max(0, int(total_pages or 0))
    now_ms = int(time.time() * 1000)
    if total == 0:
        return

    rows = [
        (
            str(job_id),
            idx,
            "queued",
            0,
            None,
            None,
            None,
            None,
            now_ms,
            now_ms,
            "queued",  # ✅ classification_status 초기화
        )
        for idx in range(total)
    ]

    conn = _connect()
    try:
        with conn.cursor() as cur:
            # classification_status 컬럼이 있는지 확인하고 삽입
            try:
                cur.executemany(
                    """
                    INSERT INTO job_pages
                    (job_id, page_index, status, attempt, is_interest, file_id, last_error, lease_until, created_ms, updated_ms, classification_status)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                        status=VALUES(status),
                        attempt=VALUES(attempt),
                        is_interest=VALUES(is_interest),
                        file_id=VALUES(file_id),
                        last_error=VALUES(last_error),
                        lease_until=VALUES(lease_until),
                        updated_ms=VALUES(updated_ms),
                        classification_status=VALUES(classification_status)
                    """,
                    rows,
                )
            except Exception:
                # classification_status 컬럼이 없으면 기존 방식으로 삽입
                rows_without_classification = [
                    (
                        str(job_id),
                        idx,
                        "queued",
                        0,
                        None,
                        None,
                        None,
                        None,
                        now_ms,
                        now_ms,
                    )
                    for idx in range(total)
                ]
                cur.executemany(
                    """
                    INSERT INTO job_pages
                    (job_id, page_index, status, attempt, is_interest, file_id, last_error, lease_until, created_ms, updated_ms)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                        status=VALUES(status),
                        attempt=VALUES(attempt),
                        is_interest=VALUES(is_interest),
                        file_id=VALUES(file_id),
                        last_error=VALUES(last_error),
                        lease_until=VALUES(lease_until),
                        updated_ms=VALUES(updated_ms)
                    """,
                    rows_without_classification,
                )
        conn.commit()
    finally:
        conn.close()


def recover_expired_processing_pages(now_ms: Optional[int] = None) -> int:
    ts = int(now_ms or int(time.time() * 1000))
    conn = _connect()
    try:
        with conn.cursor() as cur:
            affected = cur.execute(
                """
                UPDATE job_pages
                SET status='queued', lease_until=NULL, updated_ms=%s
                WHERE status='processing' AND lease_until IS NOT NULL AND lease_until < %s
                """,
                (ts, ts),
            )
        conn.commit()
        return int(affected or 0)
    finally:
        conn.close()


def claim_next_page(job_id: str, lease_seconds: int = 30) -> Optional[Dict[str, Any]]:
    now_ms = int(time.time() * 1000)
    lease_until = now_ms + max(1, int(lease_seconds or 30)) * 1000

    conn = _connect()
    try:
        with conn.cursor() as cur:
            conn.begin()
            row = None
            try:
                cur.execute(
                    """
                    SELECT job_id, page_index, attempt
                    FROM job_pages
                    WHERE job_id=%s AND status='queued'
                    ORDER BY page_index ASC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                    """,
                    (job_id,),
                )
                row = cur.fetchone()
            except Exception:
                cur.execute(
                    """
                    SELECT job_id, page_index, attempt
                    FROM job_pages
                    WHERE job_id=%s AND status='queued'
                    ORDER BY page_index ASC
                    LIMIT 1
                    FOR UPDATE
                    """,
                    (job_id,),
                )
                row = cur.fetchone()

            if row is None:
                conn.commit()
                return None

            page_index = int(_row_get(row, "page_index", 1) or 0)
            updated = cur.execute(
                """
                UPDATE job_pages
                SET status='processing', lease_until=%s, updated_ms=%s
                WHERE job_id=%s AND page_index=%s AND status='queued'
                """,
                (lease_until, now_ms, job_id, page_index),
            )
            if int(updated or 0) != 1:
                conn.rollback()
                return None

            conn.commit()
            return {
                "job_id": str(_row_get(row, "job_id", 0) or job_id),
                "page_index": page_index,
                "attempt": int(_row_get(row, "attempt", 2) or 0),
                "lease_until": lease_until,
            }
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def mark_page_done(job_id: str, page_index: int, is_interest: bool, file_id: Optional[str] = None, stored_path: Optional[str] = None, rotation: Optional[str] = None) -> None:
    now_ms = int(time.time() * 1000)
    conn = _connect()
    try:
        with conn.cursor() as cur:
            # stored_path 및 rotation 컬럼이 있는지 확인하고 업데이트
            try:
                cur.execute(
                    """
                    UPDATE job_pages
                    SET status='done', is_interest=%s, file_id=%s, stored_path=%s, rotation=%s, lease_until=NULL, last_error=NULL, updated_ms=%s
                    WHERE job_id=%s AND page_index=%s
                    """,
                    (1 if is_interest else 0, file_id, stored_path, rotation, now_ms, job_id, int(page_index)),
                )
            except Exception:
                # rotation 컬럼이 없으면 기존 방식으로 업데이트
                try:
                    cur.execute(
                        """
                        UPDATE job_pages
                        SET status='done', is_interest=%s, file_id=%s, stored_path=%s, lease_until=NULL, last_error=NULL, updated_ms=%s
                        WHERE job_id=%s AND page_index=%s
                        """,
                        (1 if is_interest else 0, file_id, stored_path, now_ms, job_id, int(page_index)),
                    )
                except Exception:
                    # stored_path 컬럼도 없으면 최소 방식으로 업데이트
                    cur.execute(
                        """
                        UPDATE job_pages
                        SET status='done', is_interest=%s, file_id=%s, lease_until=NULL, last_error=NULL, updated_ms=%s
                        WHERE job_id=%s AND page_index=%s
                        """,
                        (1 if is_interest else 0, file_id, now_ms, job_id, int(page_index)),
                    )
        conn.commit()
    finally:
        conn.close()



def mark_page_interest(job_id: str, page_index: int, file_id: Optional[str] = None) -> int:
    now_ms = int(time.time() * 1000)
    conn = _connect()
    try:
        with conn.cursor() as cur:
            affected = cur.execute(
                """
                UPDATE job_pages
                SET is_interest=1, file_id=%s, updated_ms=%s
                WHERE job_id=%s AND page_index=%s
                """,
                (file_id, now_ms, job_id, int(page_index)),
            )
        conn.commit()
        return int(affected or 0)
    finally:
        conn.close()


def set_page_interest(job_id: str, page_index: int, is_interest: bool, file_id: Optional[str] = None) -> int:
    now_ms = int(time.time() * 1000)
    conn = _connect()
    try:
        with conn.cursor() as cur:
            affected = cur.execute(
                """
                UPDATE job_pages
                SET is_interest=%s, file_id=COALESCE(%s, file_id), updated_ms=%s
                WHERE job_id=%s AND page_index=%s
                """,
                (1 if is_interest else 0, file_id, now_ms, job_id, int(page_index)),
            )
        conn.commit()
        return int(affected or 0)
    finally:
        conn.close()

def fail_page(job_id: str, page_index: int, error: str, max_attempts: int) -> str:
    now_ms = int(time.time() * 1000)
    max_try = max(1, int(max_attempts or 1))

    conn = _connect()
    try:
        with conn.cursor() as cur:
            conn.begin()
            cur.execute(
                """
                SELECT attempt
                FROM job_pages
                WHERE job_id=%s AND page_index=%s
                FOR UPDATE
                """,
                (job_id, int(page_index)),
            )
            row = cur.fetchone()
            attempt = int(_row_get(row, "attempt", 0) or 0) + 1
            next_status = "error" if attempt >= max_try else "queued"
            cur.execute(
                """
                UPDATE job_pages
                SET status=%s, attempt=%s, last_error=%s, lease_until=NULL, updated_ms=%s
                WHERE job_id=%s AND page_index=%s
                """,
                (next_status, attempt, str(error or ""), now_ms, job_id, int(page_index)),
            )
            conn.commit()
            return next_status
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def requeue_processing_pages(job_id: str) -> int:
    now_ms = int(time.time() * 1000)
    conn = _connect()
    try:
        with conn.cursor() as cur:
            affected = cur.execute(
                """
                UPDATE job_pages
                SET status='queued', lease_until=NULL, updated_ms=%s
                WHERE job_id=%s AND status='processing'
                """,
                (now_ms, job_id),
            )
        conn.commit()
        return int(affected or 0)
    finally:
        conn.close()


def requeue_failed_pages(job_id: str, reset_attempt: bool = True) -> int:
    now_ms = int(time.time() * 1000)
    conn = _connect()
    try:
        with conn.cursor() as cur:
            if reset_attempt:
                affected = cur.execute(
                    """
                    UPDATE job_pages
                    SET status='queued', attempt=0, lease_until=NULL, updated_ms=%s
                    WHERE job_id=%s AND status='error'
                    """,
                    (now_ms, job_id),
                )
            else:
                affected = cur.execute(
                    """
                    UPDATE job_pages
                    SET status='queued', lease_until=NULL, updated_ms=%s
                    WHERE job_id=%s AND status='error'
                    """,
                    (now_ms, job_id),
                )
        conn.commit()
        return int(affected or 0)
    finally:
        conn.close()


def get_job_page_stats(job_id: str) -> Dict[str, int]:
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT status, COUNT(*) AS cnt
                FROM job_pages
                WHERE job_id=%s
                GROUP BY status
                """,
                (job_id,),
            )
            rows = cur.fetchall() or []

            cur.execute(
                "SELECT COUNT(*) AS cnt FROM job_pages WHERE job_id=%s AND is_interest=1",
                (job_id,),
            )
            interest = cur.fetchone()

            cur.execute(
                "SELECT COUNT(*) AS cnt FROM job_pages WHERE job_id=%s AND status='queued' AND attempt > 0",
                (job_id,),
            )
            retrying = cur.fetchone()

        stats: Dict[str, int] = {}
        for r in rows:
            st = str(_row_get(r, "status", 0) or "")
            if st:
                stats[st] = int(_row_get(r, "cnt", 1) or 0)

        stats["interest"] = int(_row_get(interest, "cnt", 0) or 0)
        stats["retrying"] = int(_row_get(retrying, "cnt", 0) or 0)
        return stats
    finally:
        conn.close()



def list_job_pages(job_id: str, limit: int = 1000) -> list[Dict[str, Any]]:
    lim = max(1, min(int(limit or 1000), 5000))
    conn = _connect()
    try:
        with conn.cursor() as cur:
            # classification_status 컬럼이 있는지 확인하고 조회
            try:
                cur.execute(
                    """
                    SELECT job_id, page_index, status, attempt, is_interest, file_id, last_error, updated_ms, rotation, classification_status
                    FROM job_pages
                    WHERE job_id=%s
                    ORDER BY page_index ASC
                    LIMIT %s
                    """,
                    (job_id, lim),
                )
                rows = cur.fetchall() or []

                items: list[Dict[str, Any]] = []
                for r in rows:
                    items.append(
                        {
                            "job_id": str(_row_get(r, "job_id", 0) or job_id),
                            "page_index": int(_row_get(r, "page_index", 1) or 0),
                            "status": str(_row_get(r, "status", 2) or "queued"),
                            "attempt": int(_row_get(r, "attempt", 3) or 0),
                            "is_interest": _row_get(r, "is_interest", 4),
                            "file_id": _row_get(r, "file_id", 5),
                            "stored_path": None,
                            "rotation": _row_get(r, "rotation", 8),
                            "last_error": _row_get(r, "last_error", 6),
                            "updated_ms": int(_row_get(r, "updated_ms", 7) or 0),
                            "classification_status": _row_get(r, "classification_status", 9),
                        }
                    )
                return items
            except Exception:
                # classification_status 컬럼이 없으면 기존 방식으로 조회
                try:
                    cur.execute(
                        """
                        SELECT job_id, page_index, status, attempt, is_interest, file_id, last_error, updated_ms, rotation
                        FROM job_pages
                        WHERE job_id=%s
                        ORDER BY page_index ASC
                        LIMIT %s
                        """,
                        (job_id, lim),
                    )
                    rows = cur.fetchall() or []

                    items: list[Dict[str, Any]] = []
                    for r in rows:
                        items.append(
                            {
                                "job_id": str(_row_get(r, "job_id", 0) or job_id),
                                "page_index": int(_row_get(r, "page_index", 1) or 0),
                                "status": str(_row_get(r, "status", 2) or "queued"),
                                "attempt": int(_row_get(r, "attempt", 3) or 0),
                                "is_interest": _row_get(r, "is_interest", 4),
                                "file_id": _row_get(r, "file_id", 5),
                                "stored_path": None,
                                "rotation": _row_get(r, "rotation", 8),
                                "last_error": _row_get(r, "last_error", 6),
                                "updated_ms": int(_row_get(r, "updated_ms", 7) or 0),
                                "classification_status": "queued",  # 기본값
                            }
                        )
                    return items
                except Exception:
                    # rotation 컬럼도 없으면 최소 방식으로 조회
                    cur.execute(
                        """
                        SELECT job_id, page_index, status, attempt, is_interest, file_id, last_error, updated_ms
                        FROM job_pages
                        WHERE job_id=%s
                        ORDER BY page_index ASC
                        LIMIT %s
                        """,
                        (job_id, lim),
                    )
                    rows = cur.fetchall() or []

                    items: list[Dict[str, Any]] = []
                    for r in rows:
                        items.append(
                            {
                                "job_id": str(_row_get(r, "job_id", 0) or job_id),
                                "page_index": int(_row_get(r, "page_index", 1) or 0),
                                "status": str(_row_get(r, "status", 2) or "queued"),
                                "attempt": int(_row_get(r, "attempt", 3) or 0),
                                "is_interest": _row_get(r, "is_interest", 4),
                                "file_id": _row_get(r, "file_id", 5),
                                "stored_path": None,
                                "rotation": None,
                                "last_error": _row_get(r, "last_error", 6),
                                "updated_ms": int(_row_get(r, "updated_ms", 7) or 0),
                                "classification_status": "queued",  # 기본값
                            }
                        )
                    return items
    finally:
        conn.close()


def requeue_page(job_id: str, page_index: int, reset_attempt: bool = False) -> int:
    now_ms = int(time.time() * 1000)
    conn = _connect()
    try:
        with conn.cursor() as cur:
            if reset_attempt:
                affected = cur.execute(
                    """
                    UPDATE job_pages
                    SET status='queued', attempt=0, lease_until=NULL, last_error=NULL, updated_ms=%s
                    WHERE job_id=%s AND page_index=%s
                    """,
                    (now_ms, job_id, int(page_index)),
                )
            else:
                affected = cur.execute(
                    """
                    UPDATE job_pages
                    SET status='queued', lease_until=NULL, last_error=NULL, updated_ms=%s
                    WHERE job_id=%s AND page_index=%s
                    """,
                    (now_ms, job_id, int(page_index)),
                )
        conn.commit()
        return int(affected or 0)
    finally:
        conn.close()

def job_pages_total(job_id: str) -> int:
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS cnt FROM job_pages WHERE job_id=%s", (job_id,))
            row = cur.fetchone()
        return int(_row_get(row, "cnt", 0) or 0)
    finally:
        conn.close()


def list_interest_pages(job_id: str, limit: int = 1000) -> list[Dict[str, Any]]:
    """
    is_interest=1인 페이지만 조회하여 성능 최적화
    """
    lim = max(1, min(int(limit or 1000), 5000))
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT job_id, page_index, status, attempt, is_interest, file_id, last_error, updated_ms
                FROM job_pages
                WHERE job_id=%s AND is_interest=1
                ORDER BY page_index ASC
                LIMIT %s
                """,
                (job_id, lim),
            )
            rows = cur.fetchall() or []

        items: list[Dict[str, Any]] = []
        for r in rows:
            items.append(
                {
                    "job_id": str(_row_get(r, "job_id", 0) or job_id),
                    "page_index": int(_row_get(r, "page_index", 1) or 0),
                    "status": str(_row_get(r, "status", 2) or "queued"),
                    "attempt": int(_row_get(r, "attempt", 3) or 0),
                    "is_interest": _row_get(r, "is_interest", 4),
                    "file_id": _row_get(r, "file_id", 5),
                    "last_error": _row_get(r, "last_error", 6),
                    "updated_ms": int(_row_get(r, "updated_ms", 7) or 0),
                }
            )
        return items
    finally:
        conn.close()


def cancel_page(job_id: str, page_index: int) -> int:
    now_ms = int(time.time() * 1000)
    conn = _connect()
    try:
        with conn.cursor() as cur:
            affected = cur.execute(
                """
                UPDATE job_pages
                SET status='cancelled', lease_until=NULL, updated_ms=%s
                WHERE job_id=%s AND page_index=%s AND status IN ('queued', 'processing')
                """,
                (now_ms, job_id, int(page_index)),
            )
        conn.commit()
        return int(affected or 0)
    finally:
        conn.close()


def update_page_rotation(job_id: str, page_index: int, rotation: Optional[str]) -> int:
    """
    페이지의 회전 정보 업데이트
    
    Args:
        job_id: Job ID
        page_index: 페이지 인덱스
        rotation: 회전 설정 (NULL 또는 'cw')
    
    Returns:
        업데이트된 행 수
    """
    now_ms = int(time.time() * 1000)
    conn = _connect()
    try:
        with conn.cursor() as cur:
            affected = cur.execute(
                """
                UPDATE job_pages
                SET rotation=%s, updated_ms=%s
                WHERE job_id=%s AND page_index=%s
                """,
                (rotation, now_ms, job_id, int(page_index)),
            )
        conn.commit()
        return int(affected or 0)
    finally:
        conn.close()


def get_page_rotation(job_id: str, page_index: int) -> Optional[str]:
    """
    페이지의 회전 정보 조회
    
    Args:
        job_id: Job ID
        page_index: 페이지 인덱스
    
    Returns:
        회전 설정 (NULL 또는 'cw')
    """
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT rotation
                FROM job_pages
                WHERE job_id=%s AND page_index=%s
                """,
                (job_id, int(page_index)),
            )
            row = cur.fetchone()
            return _row_get(row, "rotation", 0)
    finally:
        conn.close()


def update_page_classification(job_id: str, page_index: int, is_interest: bool, rotation: Optional[str], classification_status: Optional[str] = None) -> int:
    """
    페이지의 분류 정보 업데이트 (관심 여부 + 회전 + classification_status)
    
    Args:
        job_id: Job ID
        page_index: 페이지 인덱스
        is_interest: 관심 문서 여부
        rotation: 회전 설정 (NULL 또는 'cw')
        classification_status: 분류 상태 ('queued' 또는 'requested')
    
    Returns:
        업데이트된 행 수
    """
    now_ms = int(time.time() * 1000)
    conn = _connect()
    try:
        with conn.cursor() as cur:
            # classification_status가 있는 경우 업데이트
            if classification_status is not None:
                affected = cur.execute(
                    """
                    UPDATE job_pages
                    SET is_interest=%s, rotation=%s, classification_status=%s, updated_ms=%s
                    WHERE job_id=%s AND page_index=%s
                    """,
                    (1 if is_interest else 0, rotation, classification_status, now_ms, job_id, int(page_index)),
                )
            else:
                # classification_status가 없는 경우 기존 방식으로 업데이트
                affected = cur.execute(
                    """
                    UPDATE job_pages
                    SET is_interest=%s, rotation=%s, updated_ms=%s
                    WHERE job_id=%s AND page_index=%s
                    """,
                    (1 if is_interest else 0, rotation, now_ms, job_id, int(page_index)),
                )
        conn.commit()
        return int(affected or 0)
    finally:
        conn.close()


def update_page_status(job_id: str, page_index: int, status: str) -> int:
    """
    페이지의 상태 업데이트
    
    Args:
        job_id: Job ID
        page_index: 페이지 인덱스
        status: 새로운 상태 ('queued', 'processing', 'done', 'error', 'cancelled')
    
    Returns:
        업데이트된 행 수
    """
    now_ms = int(time.time() * 1000)
    conn = _connect()
    try:
        with conn.cursor() as cur:
            affected = cur.execute(
                """
                UPDATE job_pages
                SET status=%s, lease_until=NULL, updated_ms=%s
                WHERE job_id=%s AND page_index=%s
                """,
                (status, now_ms, job_id, int(page_index)),
            )
        conn.commit()
        return int(affected or 0)
    finally:
        conn.close()


def update_page_classification_complete(
    job_id: str,
    page_index: int,
    is_interest: bool,
    rotation: Optional[str] = None,
    status: Optional[str] = None,
    file_id: Optional[str] = None
) -> int:
    """
    페이지의 분류 정보를 통합 업데이트 (성능 최적화)
    분류 정보, 상태, file_id를 단일 트랜잭션으로 업데이트
    
    Args:
        job_id: Job ID
        page_index: 페이지 인덱스
        is_interest: 관심 문서 여부
        rotation: 회전 설정 (NULL 또는 'cw')
        status: 새로운 상태 (None인 경우 업데이트 안 함)
        file_id: 파일 ID (None인 경우 업데이트 안 함)
    
    Returns:
        업데이트된 행 수
    """
    now_ms = int(time.time() * 1000)
    conn = _connect()
    try:
        with conn.cursor() as cur:
            # 기본 업데이트: 분류 정보
            update_fields = ["is_interest=%s", "rotation=%s", "updated_ms=%s"]
            params = [1 if is_interest else 0, rotation, now_ms]
            
            # 상태 업데이트 (status가 제공된 경우)
            if status is not None:
                update_fields.append("status=%s")
                params.append(status)
            
            # file_id 업데이트 (file_id가 제공된 경우)
            if file_id is not None:
                update_fields.append("file_id=%s")
                params.append(file_id)
            
            # WHERE 절 파라미터
            params.extend([job_id, int(page_index)])
            
            # 통합 업데이트 쿼리 실행
            affected = cur.execute(
                f"""
                UPDATE job_pages
                SET {', '.join(update_fields)}
                WHERE job_id=%s AND page_index=%s
                """,
                params
            )
        conn.commit()
        return int(affected or 0)
    finally:
        conn.close()


def update_page_is_interest(job_id: str, page_index: int, is_interest: bool) -> int:
    """
    페이지의 관심 여부 업데이트
    
    Args:
        job_id: Job ID
        page_index: 페이지 인덱스
        is_interest: 관심 문서 여부 (True/False)
    
    Returns:
        업데이트된 행 수
    """
    now_ms = int(time.time() * 1000)
    conn = _connect()
    try:
        with conn.cursor() as cur:
            affected = cur.execute(
                """
                UPDATE job_pages
                SET is_interest=%s, updated_ms=%s
                WHERE job_id=%s AND page_index=%s
                """,
                (1 if is_interest else 0, now_ms, job_id, int(page_index)),
            )
        conn.commit()
        return int(affected or 0)
    finally:
        conn.close()


def get_page_by_index(job_id: str, page_index: int) -> Optional[Dict[str, Any]]:
    """
    단일 페이지 조회 (성능 최적화)
    
    Args:
        job_id: Job ID
        page_index: 페이지 인덱스
    
    Returns:
        페이지 정보 딕셔너리 또는 None (페이지가 없는 경우)
    """
    conn = _connect()
    try:
        with conn.cursor() as cur:
            # rotation 컬럼이 있는지 확인하고 조회
            try:
                cur.execute(
                    """
                    SELECT job_id, page_index, status, attempt, is_interest, file_id, last_error, updated_ms, rotation
                    FROM job_pages
                    WHERE job_id=%s AND page_index=%s
                    """,
                    (job_id, int(page_index)),
                )
                row = cur.fetchone()
                if row is None:
                    return None
                
                return {
                    "job_id": str(_row_get(row, "job_id", 0) or job_id),
                    "page_index": int(_row_get(row, "page_index", 1) or 0),
                    "status": str(_row_get(row, "status", 2) or "queued"),
                    "attempt": int(_row_get(row, "attempt", 3) or 0),
                    "is_interest": _row_get(row, "is_interest", 4),
                    "file_id": _row_get(row, "file_id", 5),
                    "stored_path": None,
                    "rotation": _row_get(row, "rotation", 8),
                    "last_error": _row_get(row, "last_error", 6),
                    "updated_ms": int(_row_get(row, "updated_ms", 7) or 0),
                }
            except Exception:
                # rotation 컬럼이 없으면 기존 방식으로 조회
                cur.execute(
                    """
                    SELECT job_id, page_index, status, attempt, is_interest, file_id, last_error, updated_ms
                    FROM job_pages
                    WHERE job_id=%s AND page_index=%s
                    """,
                    (job_id, int(page_index)),
                )
                row = cur.fetchone()
                if row is None:
                    return None
                
                return {
                    "job_id": str(_row_get(row, "job_id", 0) or job_id),
                    "page_index": int(_row_get(row, "page_index", 1) or 0),
                    "status": str(_row_get(row, "status", 2) or "queued"),
                    "attempt": int(_row_get(row, "attempt", 3) or 0),
                    "is_interest": _row_get(row, "is_interest", 4),
                    "file_id": _row_get(row, "file_id", 5),
                    "stored_path": None,
                    "rotation": None,
                    "last_error": _row_get(row, "last_error", 6),
                    "updated_ms": int(_row_get(row, "updated_ms", 7) or 0),
                }
    finally:
        conn.close()


def delete_job_pages(job_id: str) -> int:
    """
    특정 job의 모든 페이지 삭제
    
    Args:
        job_id: Job ID
    
    Returns:
        삭제된 행 수
    """
    conn = _connect()
    try:
        with conn.cursor() as cur:
            affected = cur.execute(
                """
                DELETE FROM job_pages
                WHERE job_id=%s
                """,
                (job_id,),
            )
        conn.commit()
        return int(affected or 0)
    finally:
        conn.close()
