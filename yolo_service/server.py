from __future__ import annotations

import uvicorn
import os

from core.logging import init_logging
from .app import create_app


def main() -> None:
    log_config = init_logging("yolo")
    uvicorn.run(
        "yolo_service.app:create_app",
        host="127.0.0.1",
        port=int(os.getenv("PORT", 8011)),
        reload=False,
        workers=1,  # Windows 호환성을 위해 단일 워커 사용 (child process 문제 해결)
        log_level=None,
        log_config=log_config,
        factory=True,
        timeout_keep_alive=600,  # keep-alive 타임아웃 10분
        timeout_graceful_shutdown=30,  # graceful shutdown 타임아웃 30초
        limit_concurrency=10,  # 동시 요청 수 제한 (GPU 리소스 고려)
    )


if __name__ == "__main__":
    main()
