from __future__ import annotations

import uvicorn

from core.logging import init_logging
import logging
from . import config
from .app import create_app


def main() -> None:
    log_config = init_logging(
        service_name="api",
        level=logging.getLevelName(logging.DEBUG)  # → "DEBUG"
    )    
    config.ensure_dirs()
    uvicorn.run(
        "api_service.app:create_app",
        host=config.API_HOST,
        port=config.API_PORT,
        reload=False,
        workers=1,  # Windows 호환성을 위해 단일 워커 사용
        log_level="debug",
        log_config=log_config,
        limit_concurrency=500,  # 동시 요청 수 제한 (I/O 작업)
    )


if __name__ == "__main__":
    main()
