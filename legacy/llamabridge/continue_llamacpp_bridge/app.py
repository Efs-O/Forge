"""FastAPI app: OpenAI-style ``/v1/models`` and ``/v1/chat/completions`` proxy."""

from __future__ import annotations

import json
import logging
import secrets
import time
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import sampling as yaml_samp
from .llama_server import LlamaServerProc

logger = logging.getLogger("continue_llamacpp_bridge.app")


def _parse_sse_data_line(line: str) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Parse one SSE line ``data: {...}``. Return (usage dict, delta text) if present."""
    s = line.strip()
    if not s.startswith("data:"):
        return None, None
    raw = s[5:].strip()
    if not raw or raw == "[DONE]":
        return None, None
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return None, None
    if not isinstance(obj, dict):
        return None, None
    usage = obj.get("usage")
    usage_out = usage if isinstance(usage, dict) and usage else None
    delta_content: Optional[str] = None
    choices = obj.get("choices")
    if isinstance(choices, list) and choices:
        c0 = choices[0]
        if isinstance(c0, dict):
            delta = c0.get("delta")
            if isinstance(delta, dict):
                dc = delta.get("content")
                if isinstance(dc, str) and dc:
                    delta_content = dc
    return usage_out, delta_content


def _log_usage_vs_ctx(usage: Dict[str, Any], context_slots: Optional[int]) -> None:
    """Log prompt/completion counts and rough remaining slots vs ``num_ctx``."""
    pt = usage.get("prompt_tokens")
    ct = usage.get("completion_tokens")
    if not isinstance(pt, int) or not isinstance(ct, int):
        logger.info("[bridge] usage (partial keys): %s", usage)
        return
    logger.info("[bridge] usage prompt_tokens=%s completion_tokens=%s", pt, ct)
    if context_slots is not None:
        approx_used = pt + ct
        approx_left = max(0, context_slots - approx_used)
        logger.info(
            "[bridge] vs num_ctx=%s approx_total_used=%s approx_remaining_in_ctx=%s (see README; upstream may omit usage in stream)",
            context_slots,
            approx_used,
            approx_left,
        )


def load_yaml(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)
    if not isinstance(raw, dict):
        raise ValueError("YAML root must be a mapping")
    return raw


def resolve_gguf(config_path: Path, rel_or_abs: str) -> Path:
    p = Path(rel_or_abs)
    return p.resolve() if p.is_absolute() else (config_path.parent / p).resolve()


def require_bearer(request: Request, expected: str) -> None:
    auth = request.headers.get("authorization") or ""
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token")
    tok = auth[7:].strip()
    if not secrets.compare_digest(tok, expected):
        raise HTTPException(401, "Invalid bearer token")


def merge_reasoning_chat(body: Dict[str, Any], think: bool) -> None:
    """Set thinking-related fields for llama.cpp chat template compatibility."""
    body.setdefault("chat_template_kwargs", {})
    if not isinstance(body["chat_template_kwargs"], dict):
        body["chat_template_kwargs"] = {}
    if think:
        body["chat_template_kwargs"]["enable_thinking"] = True
    else:
        body["reasoning_format"] = "none"
        body["chat_template_kwargs"]["enable_thinking"] = False


def _merge_system_prompt_into_messages(body: Dict[str, Any], system_prompt: str) -> None:
    """Inject or extend the first system message with a bridge-defined prompt."""
    if not system_prompt:
        return
    msgs = body.get("messages")
    if not isinstance(msgs, list):
        return
    if msgs and isinstance(msgs[0], dict) and msgs[0].get("role") == "system":
        content = msgs[0].get("content")
        if isinstance(content, str):
            msgs[0]["content"] = f"{content.rstrip()}\n\n{system_prompt}"
            return
        if isinstance(content, list):
            content.append({"type": "text", "text": system_prompt})
            return
    msgs.insert(0, {"role": "system", "content": system_prompt})


def _strip_openai_tools_from_chat_payload(out: Dict[str, Any]) -> None:
    """Remove tool / function-calling fields (llama-server may 500 on bad tool JSON in history or output)."""
    for k in (
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "functions",
        "function_call",
    ):
        out.pop(k, None)
    msgs = out.get("messages")
    if not isinstance(msgs, list):
        return
    cleaned: List[Dict[str, Any]] = []
    for m in msgs:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role in ("tool", "function"):
            continue
        had_tool_calls = "tool_calls" in m
        msg = {k: v for k, v in m.items() if k not in ("tool_calls", "function_call")}
        if had_tool_calls and msg.get("content") is None and msg.get("role") == "assistant":
            msg["content"] = ""
        cleaned.append(msg)
    out["messages"] = cleaned


def build_app(
    raw: Dict[str, Any],
    config_path: Path,
    *,
    debug: bool = False,
) -> Tuple[FastAPI, LlamaServerProc]:
    api_key = str(raw["api_key"])
    models_raw = raw["models"]
    if not isinstance(models_raw, dict):
        raise ValueError("models must be a mapping")
    ls_candidate = raw.get("llama_server")
    ls_raw: Dict[str, Any] = ls_candidate if isinstance(ls_candidate, dict) else {}
    proc = LlamaServerProc(ls_raw, debug=debug)

    app = FastAPI(title="continue-llamacpp-bridge", version="1.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    async def list_models(request: Request) -> JSONResponse:
        require_bearer(request, api_key)
        now = int(time.time())
        data = [
            {"id": k, "object": "model", "created": now, "owned_by": "continue-llamacpp-bridge"}
            for k in sorted(models_raw.keys())
        ]
        return JSONResponse({"object": "list", "data": data})

    app.add_api_route("/v1/models", list_models, methods=["GET"])

    async def _iter_upstream_sse(
        resp: httpx.Response,
        *,
        stream_debug: bool,
        context_slots: Optional[int],
    ) -> AsyncIterator[bytes]:
        """Stream bytes from an already-open 200 httpx response (SSE from llama-server)."""
        line_buf = ""
        try:
            async for chunk in resp.aiter_bytes():
                if stream_debug:
                    line_buf += chunk.decode("utf-8", errors="replace")
                    while True:
                        nl = line_buf.find("\n")
                        if nl == -1:
                            break
                        raw_line = line_buf[:nl]
                        line_buf = line_buf[nl + 1 :]
                        usage, delta = _parse_sse_data_line(raw_line)
                        if usage:
                            _log_usage_vs_ctx(usage, context_slots)
                        elif delta:
                            safe = delta.replace("\n", "\\n")
                            if len(safe) > 200:
                                safe = safe[:200] + "..."
                            logger.debug("[stream] delta %r", safe)
                yield chunk
        finally:
            await resp.aclose()

    async def chat(request: Request) -> Response:
        require_bearer(request, api_key)
        try:
            body = await request.json()
        except Exception as exc:
            raise HTTPException(400, "Invalid JSON") from exc
        if not isinstance(body, dict):
            raise HTTPException(400, "Body must be object")
        alias = body.get("model")
        if not isinstance(alias, str) or not alias.strip():
            raise HTTPException(400, "Missing model")
        alias = alias.strip()
        if alias not in models_raw:
            raise HTTPException(400, f"Unknown model: {alias}")
        m = models_raw[alias]
        if not isinstance(m, dict):
            raise HTTPException(400, "Bad model entry")
        gguf = resolve_gguf(config_path, str(m["gguf_path"]).strip())
        num_ctx = m.get("num_ctx")
        if num_ctx is not None and not isinstance(num_ctx, int):
            raise HTTPException(400, "num_ctx must be int")
        fa = m.get("flash_attn")
        if fa is not None and not isinstance(fa, bool):
            raise HTTPException(400, "flash_attn must be bool")
        think = bool(m.get("think", False))
        extra = m.get("extra_llama_server_args") or []
        if not isinstance(extra, list) or not all(isinstance(x, str) for x in extra):
            raise HTTPException(400, "extra_llama_server_args must be list[str]")
        nb_ov = m.get("n_batch")
        if nb_ov is not None and not isinstance(nb_ov, int):
            raise HTTPException(400, "n_batch must be int")
        if nb_ov is not None and nb_ov < 1:
            raise HTTPException(400, "n_batch must be >= 1")
        try:
            proc.start(str(gguf), num_ctx, fa, list(extra), n_batch_override=nb_ov)
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc
        logger.info(
            "[bridge] continue model=%r → GGUF=%s upstream model=%r",
            alias,
            gguf.name,
            gguf.stem,
        )
        out = dict(body)
        out["model"] = gguf.stem
        merge_reasoning_chat(out, think)
        sp = m.get("system_prompt")
        if sp is not None and not isinstance(sp, str):
            raise HTTPException(400, "system_prompt must be str")
        if isinstance(sp, str) and sp.strip():
            _merge_system_prompt_into_messages(out, sp.strip())
        try:
            sm = yaml_samp.validate_sampling_mapping(
                m.get("sampling"), label=f"models.{alias}.sampling"
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        yaml_samp.merge_yaml_sampling_into_chat_payload(sm, out)
        st = m.get("strip_tools")
        if st is None:
            st = raw.get("strip_tools", False)
        if bool(st):
            _strip_openai_tools_from_chat_payload(out)
        if debug:
            logger.debug("[bridge] upstream chat payload keys: %s", sorted(out.keys()))
        url = f"{proc.base_url()}/v1/chat/completions"
        ctx_slots = num_ctx  # already validated as int or None
        if out.get("stream", True):
            # Open upstream first, check status, then return StreamingResponse. If we returned
            # StreamingResponse that raised on first chunk, Starlette would already have sent 200
            # to the client, causing "response already started" when mapping upstream 5xx to errors.
            timeout = httpx.Timeout(connect=60.0, read=None, write=60.0, pool=60.0)
            client: Optional[httpx.AsyncClient] = httpx.AsyncClient(timeout=timeout)
            try:
                req = client.build_request("POST", url, json=out)
                up = await client.send(req, stream=True)
                if up.status_code != 200:
                    b = await up.aread()
                    await up.aclose()
                    await client.aclose()
                    client = None
                    err_preview = b.decode("utf-8", errors="replace")[:2000]
                    logger.warning(
                        "[bridge] upstream /v1/chat/completions %s: %s",
                        up.status_code,
                        err_preview,
                    )
                    return Response(
                        content=b,
                        status_code=up.status_code,
                        media_type=up.headers.get("content-type", "application/json")
                        or "application/json",
                    )

                async def forward() -> AsyncIterator[bytes]:
                    try:
                        async for part in _iter_upstream_sse(
                            up,
                            stream_debug=debug,
                            context_slots=ctx_slots,
                        ):
                            yield part
                    finally:
                        if client is not None:
                            await client.aclose()

                return StreamingResponse(
                    forward(),
                    media_type="text/event-stream",
                )
            except httpx.RequestError as exc:
                if client is not None:
                    await client.aclose()
                raise HTTPException(502, f"Upstream: {exc}") from exc
        timeout = httpx.Timeout(connect=60.0, read=600.0, write=60.0, pool=60.0)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                r = await client.post(url, json=out)
        except httpx.RequestError as exc:
            raise HTTPException(502, f"Upstream: {exc}") from exc
        if debug and r.status_code == 200:
            try:
                body_json = json.loads(r.content.decode("utf-8", errors="replace"))
                if isinstance(body_json, dict) and isinstance(body_json.get("usage"), dict):
                    _log_usage_vs_ctx(body_json["usage"], ctx_slots)
            except (json.JSONDecodeError, UnicodeError):
                pass
        return Response(
            content=r.content,
            status_code=r.status_code,
            media_type=r.headers.get("content-type", "application/json"),
        )

    app.add_api_route("/v1/chat/completions", chat, methods=["POST"])

    return app, proc
