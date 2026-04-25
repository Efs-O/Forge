"""Command-line entry: load YAML, run uvicorn."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import uvicorn

from .app import build_app, load_yaml


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Continue <-> llama-server bridge (OpenAI-compatible HTTP API).",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Verbose logs and stream llama-server stdout/stderr to this terminal.",
    )
    parser.add_argument("config", type=Path, help="Path to bridge YAML")
    args = parser.parse_args(argv)
    level = logging.DEBUG if args.debug else logging.INFO
    logging.basicConfig(level=level, format="%(levelname)s %(message)s")
    cfg_path = args.config.resolve()
    raw = load_yaml(cfg_path)
    app, _proc = build_app(raw, cfg_path, debug=args.debug)
    host = str(raw.get("bind_host", "127.0.0.1"))
    port = int(raw.get("bind_port", 9099))
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="debug" if args.debug else "info",
        timeout_keep_alive=300,
    )


if __name__ == "__main__":
    main(sys.argv[1:])
