from __future__ import annotations

import uvicorn
import os 

from core.logging import init_logging
from .app import create_app


def main() -> None:
    log_config = init_logging("doc_filter", use_rotation=False)
    uvicorn.run(
        "doc_filter_service.app:create_app",  # import string 형태로 변경
        host="127.0.0.1",
        port=int(os.getenv("PORT", 8013)),
        workers=1,  # Windows 호환성을 위해 단일 워커 사용 (child process 문제 해결)
        reload=False,
        log_level=None,
        log_config=log_config,
        factory=True,  # factory 모드 활성화
        limit_concurrency=100,  # 동시 요청 수 제한 (CPU 작업)
    )


if __name__ == "__main__":
    main()
