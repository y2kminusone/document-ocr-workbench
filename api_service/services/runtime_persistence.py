from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import asdict
from functools import wraps
from pathlib import Path
from typing import Dict, Tuple, Callable, Any

from .. import config, state
from ..models import Job, StoredFile
from ..utils import now_ms

logger = logging.getLogger("api")


# 디바운싱 데코레이터
def debounce_persist(delay: float = 1.0) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """
    persist_runtime_manifests() 호출을 디바운싱하여
    연속된 호출 중 마지막 호출만 실행합니다.
    
    Args:
        delay: 디바운싱 지연 시간 (초 단위)
    
    Returns:
        데코레이터 함수
    """
    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        last_call = [0.0]
        timer = [None]
        lock = threading.Lock()
        
        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> None:
            with lock:
                last_call[0] = time.time()
                
                # 이전 타이머가 있으면 취소
                if timer[0] is not None:
                    try:
                        timer[0].cancel()
                    except Exception:
                        pass
                
                # 새 타이머 설정
                def delayed_call() -> None:
                    with lock:
                        if time.time() - last_call[0] >= delay:
                            try:
                                func(*args, **kwargs)
                            except Exception:
                                logger.warning("debounced_persist_failed", exc_info=True)
                            finally:
                                timer[0] = None
                
                timer[0] = threading.Timer(delay, delayed_call)
                timer[0].start()
        
        return wrapper
    return decorator


# 디바운싱된 persist_runtime_manifests 함수
@debounce_persist(delay=1.0)
def persist_runtime_manifests_debounced() -> None:
    """
    디바운싱이 적용된 persist_runtime_manifests() 함수입니다.
    연속된 호출 중 마지막 호출만 실행됩니다.
    """
    persist_runtime_manifests()


def _atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(path)


def persist_runtime_manifests() -> None:
    try:
        with state.STATE_LOCK:
            config.ensure_dirs()
            payload_jobs = {
                "version": 1,
                "updated_ms": now_ms(),
                "jobs": [asdict(job) for job in state.JOBS.values()],
            }
            payload_files = {
                "version": 1,
                "updated_ms": now_ms(),
                "files": [asdict(stored) for stored in state.FILES.values()],
            }
            _atomic_write_json(config.JOBS_MANIFEST_PATH, payload_jobs)
            _atomic_write_json(config.FILES_MANIFEST_PATH, payload_files)
    except Exception:
        logger.warning("persist_runtime_manifests_failed", exc_info=True)


def _load_manifest_items(path: Path, key: str) -> list:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get(key)
    if not isinstance(items, list):
        return []
    return items


def _best_effort_restore_from_results() -> Tuple[int, int]:
    restored_files = 0
    parse_failed = 0
    for result_path in sorted(config.RESULTS_DIR.glob("*.json")):
        file_id = result_path.stem
        if file_id in state.FILES:
            continue

        try:
            result_data = json.loads(result_path.read_text(encoding="utf-8"))
        except Exception:
            parse_failed += 1
            continue

        image_name = str(result_data.get("image_name") or f"{file_id}.png")
        fallback_image = config.DERIVED_DIR / image_name
        stored_file = StoredFile(
            file_id=file_id,
            kind="image",
            original_name=image_name,
            stored_path=str(fallback_image),
            status="done",
            result=result_data,
            error="restored_without_manifest",
        )
        state.FILES[file_id] = stored_file
        restored_files += 1

    state.rebuild_file_source_index()
    return restored_files, parse_failed


def restore_runtime_state() -> Dict[str, int]:
    config.ensure_dirs()
    state.JOBS.clear()
    state.FILES.clear()
    state.FILE_SOURCE_INDEX.clear()

    restored_jobs = 0
    restored_files = 0
    parse_failed = 0

    # ========== 기존 JSON 파일 복구 (주석 처리) ==========
    # try:
    #     job_items = _load_manifest_items(config.JOBS_MANIFEST_PATH, "jobs")
    #     for item in job_items:
    #         if not isinstance(item, dict):
    #             parse_failed += 1
    #             continue
    #         try:
    #             job = Job(**item)
    #         except Exception:
    #             parse_failed += 1
    #             continue
    #         state.JOBS[job.job_id] = job
    #         restored_jobs += 1

    #     file_items = _load_manifest_items(config.FILES_MANIFEST_PATH, "files")
    #     for item in file_items:
    #         if not isinstance(item, dict):
    #             parse_failed += 1
    #             continue
    #         try:
    #             stored_file = StoredFile(**item)
    #         except Exception:
    #             parse_failed += 1
    #             continue
    #         state.FILES[stored_file.file_id] = stored_file
    #         restored_files += 1

    #     if restored_jobs == 0 and restored_files == 0:
    #         fallback_files, fallback_failed = _best_effort_restore_from_results()
    #         restored_files += fallback_files
    #         parse_failed += fallback_failed
    # except Exception:
    #     logger.warning("manifest_restore_failed -> fallback to results scan", exc_info=True)
    #     fallback_files, fallback_failed = _best_effort_restore_from_results()
    #     restored_files += fallback_files
    #     parse_failed += fallback_failed
    # =====================================================

    # ========== DB에서 복구 (새로운 방식) ==========
    try:
        from core import ocr_db
        from ..repositories import db_repo
        
        cfg = db_repo.load_cfg()
        conn = ocr_db.connect(cfg)
        
        try:
            # files 테이블에서 데이터 조회
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM ocr_portfolio.files")
            file_items = cursor.fetchall()
            
            logger.info(f"DB에서 {len(file_items)}개 파일 조회 완료")
            
            for item in file_items:
                if not isinstance(item, dict):
                    parse_failed += 1
                    continue
                try:
                    # JSON 필드 명시적 파싱
                    result = item.get('result')
                    if isinstance(result, str):
                        result = json.loads(result)
                    
                    stage_stats = item.get('stage_stats')
                    if isinstance(stage_stats, str):
                        stage_stats = json.loads(stage_stats)
                    
                    # is_interest 처리 (MySQL에서는 0/1로 저장될 수 있음)
                    is_interest = item.get('is_interest')
                    if is_interest is not None:
                        # 0/1 → False/True 변환
                        if isinstance(is_interest, int):
                            is_interest = bool(is_interest)
                        # 문자열 "true"/"false" → True/False 변환
                        elif isinstance(is_interest, str):
                            is_interest = is_interest.lower() in ('true', '1', 'yes')
                    
                    stored_file = StoredFile(
                        file_id=item['file_id'],
                        kind=item['kind'],
                        original_name=item['original_name'],
                        stored_path=item['stored_path'],
                        created_ms=item['created_ms'],
                        status=item['status'],
                        error=item['error'],
                        rotation=item['rotation'],
                        result=result,  # 명시적 파싱된 dict
                        job_id=item['job_id'],
                        page_no=item['page_no'],
                        is_interest=is_interest,  # 명시적 변환
                        stage_stats=stage_stats  # 명시적 파싱된 dict
                    )
                    state.FILES[stored_file.file_id] = stored_file
                    restored_files += 1
                except Exception as e:
                    parse_failed += 1
                    logger.warning(f"파일 복구 실패 [{item.get('file_id')}]: {e}")
                    continue
            
            cursor.close()
            
            # ========== jobs 테이블에서 데이터 조회 ==========
            try:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM ocr_portfolio.jobs")
                job_items = cursor.fetchall()
                
                logger.info(f"DB에서 {len(job_items)}개 작업 조회 완료")
                
                for item in job_items:
                    if not isinstance(item, dict):
                        parse_failed += 1
                        continue
                    try:
                        # JSON 필드 명시적 파싱
                        progress = item.get('progress')
                        if isinstance(progress, str):
                            progress = json.loads(progress)
                        
                        logs = item.get('logs')
                        if isinstance(logs, str):
                            logs = json.loads(logs)
                        
                        # cancel_requested 처리 (MySQL에서는 0/1로 저장될 수 있음)
                        cancel_requested = item.get('cancel_requested')
                        if cancel_requested is not None:
                            if isinstance(cancel_requested, int):
                                cancel_requested = bool(cancel_requested)
                            elif isinstance(cancel_requested, str):
                                cancel_requested = cancel_requested.lower() in ('true', '1', 'yes')
                        
                        # pdf_scan_done 처리
                        pdf_scan_done = item.get('pdf_scan_done')
                        if pdf_scan_done is not None:
                            if isinstance(pdf_scan_done, int):
                                pdf_scan_done = bool(pdf_scan_done)
                            elif isinstance(pdf_scan_done, str):
                                pdf_scan_done = pdf_scan_done.lower() in ('true', '1', 'yes')
                        
                        job = Job(
                            job_id=item['job_id'],
                            kind=item['kind'],
                            created_ms=item['created_ms'],
                            status=item['status'],
                            progress=progress,  # 명시적 파싱된 dict
                            error=item['error'],
                            cancel_requested=cancel_requested,  # 명시적 변환
                            pdf_path=item['pdf_path'],
                            pdf_name=item['pdf_name'],
                            pdf_dpi=item['pdf_dpi'],
                            pdf_rotation=item['pdf_rotation'],
                            pdf_scan_done=pdf_scan_done,  # 명시적 변환
                            name=item['name'],
                            log_seq=item['log_seq'],
                            logs=logs  # 명시적 파싱된 dict
                        )
                        state.JOBS[job.job_id] = job
                        restored_jobs += 1
                    except Exception as e:
                        parse_failed += 1
                        logger.warning(f"작업 복구 실패 [{item.get('job_id')}]: {e}")
                        continue
                
                cursor.close()
                
            except Exception as e:
                # jobs 테이블이 없거나 에러 발생 시 JSON으로 폴백
                logger.warning(f"jobs DB 복구 실패, JSON으로 폴백: {e}")
                
                # jobs는 JSON 파일에서 복구
                try:
                    job_items = _load_manifest_items(config.JOBS_MANIFEST_PATH, "jobs")
                    for item in job_items:
                        if not isinstance(item, dict):
                            parse_failed += 1
                            continue
                        try:
                            job = Job(**item)
                        except Exception:
                            parse_failed += 1
                            continue
                        state.JOBS[job.job_id] = job
                        restored_jobs += 1
                    
                    logger.info(f"JSON에서 {restored_jobs}개 작업 복구 완료")
                    
                except Exception as e2:
                    logger.warning(f"jobs JSON 복구도 실패: {e2}")
            # =====================================================
                
        finally:
            conn.close()
            
        logger.info(f"DB 복구 완료: jobs={restored_jobs}, files={restored_files}, failed={parse_failed}")
        
    except Exception as e:
        logger.error(f"DB 복구 실패, JSON 파일로 폴백: {e}", exc_info=True)
        
        # DB 복구 실패 시 JSON 파일로 폴백
        try:
            job_items = _load_manifest_items(config.JOBS_MANIFEST_PATH, "jobs")
            for item in job_items:
                if not isinstance(item, dict):
                    parse_failed += 1
                    continue
                try:
                    job = Job(**item)
                except Exception:
                    parse_failed += 1
                    continue
                state.JOBS[job.job_id] = job
                restored_jobs += 1

            file_items = _load_manifest_items(config.FILES_MANIFEST_PATH, "files")
            for item in file_items:
                if not isinstance(item, dict):
                    parse_failed += 1
                    continue
                try:
                    stored_file = StoredFile(**item)
                except Exception:
                    parse_failed += 1
                    continue
                state.FILES[stored_file.file_id] = stored_file
                restored_files += 1

            if restored_jobs == 0 and restored_files == 0:
                fallback_files, fallback_failed = _best_effort_restore_from_results()
                restored_files += fallback_files
                parse_failed += fallback_failed
        except Exception:
            logger.warning("JSON 폴백도 실패, results 스캔 시도", exc_info=True)
            fallback_files, fallback_failed = _best_effort_restore_from_results()
            restored_files += fallback_files
            parse_failed += fallback_failed
    # ================================================

    state.rebuild_file_source_index()

    # dangling references를 안전하게 정리
    for job in state.JOBS.values():
        job.file_ids = [fid for fid in (job.file_ids or []) if fid in state.FILES]

    return {
        "jobs": restored_jobs,
        "files": restored_files,
        "parse_failed": parse_failed,
    }
