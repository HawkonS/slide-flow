import argparse
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn

from .api import create_app
from .config import Settings


def main():
    parser = argparse.ArgumentParser(description="Authenticated single-worker WPS renderer")
    parser.add_argument("--config", default="config.json")
    args = parser.parse_args()
    settings = Settings.load(args.config)
    log_dir = Path(args.config).resolve().parent / "logs"
    log_dir.mkdir(exist_ok=True)
    handler = RotatingFileHandler(log_dir / "renderer.log", maxBytes=1024 * 1024,
                                  backupCount=2, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, handlers=[handler],
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # One worker is deliberate: WPS/font activation must never overlap.
    server_options = {
        "host": "127.0.0.1",
        "port": settings.port,
        "workers": 1,
        "access_log": False,
        "limit_concurrency": 32,
        "timeout_keep_alive": 30,
        "limit_max_requests": None,
        "server_header": False,
        "log_config": None,
    }
    uvicorn.run(create_app(settings), **server_options)


if __name__ == "__main__":
    main()
