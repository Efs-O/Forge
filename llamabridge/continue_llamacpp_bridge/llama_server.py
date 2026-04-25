"""Subprocess lifecycle for ``llama-server`` (GGUF load, health poll)."""

from __future__ import annotations

import logging
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger("continue_llamacpp_bridge.llama_server")

_HEALTH_TIMEOUT = 3.0
_STARTUP_POLL = 1.0
_STARTUP_MAX_WAIT = 120.0
_STOP_TIMEOUT = 10.0


def _norm_path(p: str) -> str:
    return os.path.normcase(str(Path(p).resolve()))


class LlamaServerProc:
    """Start and stop ``llama-server`` with a conventional CLI argument layout."""

    def __init__(self, ls: Dict[str, Any], *, debug: bool = False) -> None:
        self._debug = debug
        self._binary = str(ls.get("binary") or os.environ.get("LLAMA_SERVER_BINARY") or "").strip()
        self._host = str(ls.get("host", "127.0.0.1"))
        self._port = int(ls.get("port", 8080))
        self._n_gpu = int(ls.get("n_gpu_layers", -1))
        self._n_batch = int(ls.get("n_batch", 512))
        self._n_parallel = int(ls.get("n_parallel", 1))
        self._type_k = ls.get("type_k", 8)
        self._type_v = ls.get("type_v", 8)
        self._def_ctx = int(ls.get("default_num_ctx", 4096))
        self._def_flash = bool(ls.get("flash_attn_default", True))
        nt = int(ls.get("n_threads", 0))
        ntb = int(ls.get("n_threads_batch", 0))
        self._threads = nt if nt > 0 else 6
        self._threads_batch = ntb if ntb > 0 else 6
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._cur_model: Optional[str] = None
        self._cur_ctx: Optional[int] = None
        self._cur_batch: Optional[int] = None

    def base_url(self) -> str:
        return f"http://{self._host}:{self._port}"

    def is_up(self) -> bool:
        try:
            r = requests.get(f"{self.base_url()}/v1/models", timeout=_HEALTH_TIMEOUT)
            return r.status_code == 200
        except requests.RequestException:
            return False

    def _compose_cmd(
        self,
        gguf: str,
        ctx: int,
        fa: bool,
        extra: Optional[List[str]],
        batch_size: int,
    ) -> List[str]:
        tk = self._type_k
        tv = self._type_v
        cmd: List[str] = [
            self._binary,
            "-m",
            gguf,
            "--jinja",
            "--host",
            self._host,
            "--port",
            str(self._port),
            "--n-gpu-layers",
            str(self._n_gpu),
            "--ctx-size",
            str(ctx),
            "--batch-size",
            str(batch_size),
            "--cache-type-k",
            f"q{tk}_0" if tk else "f16",
            "--cache-type-v",
            f"q{tv}_0" if tv else "f16",
            "--parallel",
            str(self._n_parallel),
            "--flash-attn",
            "on" if fa else "off",
            "--threads",
            str(self._threads),
            "--threads-batch",
            str(self._threads_batch),
        ]
        if extra:
            cmd.extend(str(x) for x in extra)
        return cmd

    def start(
        self,
        gguf: str,
        num_ctx: Optional[int],
        flash_attn: Optional[bool],
        extra: Optional[List[str]],
        n_batch_override: Optional[int] = None,
    ) -> None:
        if not self._binary or not Path(self._binary).is_file():
            raise RuntimeError(
                "llama-server binary not set. Add llama_server.binary to YAML "
                "or set LLAMA_SERVER_BINARY.",
            )
        if not Path(gguf).is_file():
            raise RuntimeError(f"GGUF not found: {gguf}")
        want = _norm_path(gguf)
        ctx = self._def_ctx if num_ctx is None else int(num_ctx)
        batch = self._n_batch if n_batch_override is None else int(n_batch_override)
        fa = self._def_flash if flash_attn is None else bool(flash_attn)
        ex = list(extra) if extra else []
        cmd = self._compose_cmd(gguf, ctx, fa, ex, batch)
        if self.is_up():
            if self._cur_model == want and self._cur_ctx == ctx and self._cur_batch == batch:
                logger.info(
                    "[llama-server] unchanged for %s (ctx-size=%s batch=%s); same GGUF already loaded",
                    Path(gguf).name,
                    ctx,
                    batch,
                )
                logger.info("[llama-server] argv: %s", subprocess.list2cmdline(cmd))
                return
            self.stop()
        cmdline = subprocess.list2cmdline(cmd)
        logger.info(
            "[llama-server] load model=%s ctx-size=%s batch=%s flash-attn=%s",
            Path(gguf).name,
            ctx,
            batch,
            fa,
        )
        logger.info("[llama-server] argv: %s", cmdline)
        if self._debug:
            logger.debug("[llama-server] extra_llama_server_args: %s", ex)
        out_err: Optional[int] = None if self._debug else subprocess.DEVNULL
        self._proc = subprocess.Popen(cmd, stdout=out_err, stderr=out_err)
        deadline = time.monotonic() + _STARTUP_MAX_WAIT
        while time.monotonic() < deadline:
            time.sleep(_STARTUP_POLL)
            if self.is_up():
                self._cur_model = want
                self._cur_ctx = ctx
                self._cur_batch = batch
                logger.info("[llama-server] ready at %s", self.base_url())
                return
            if self._proc.poll() is not None:
                raise RuntimeError(f"llama-server exited (code {self._proc.returncode})")
        self.stop()
        raise RuntimeError("llama-server did not become ready in time")

    def stop(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=_STOP_TIMEOUT)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait()
        self._proc = None
        self._cur_model = None
        self._cur_ctx = None
        self._cur_batch = None
