"""Validate and merge per-model ``sampling`` from bridge YAML into chat JSON.

YAML ``sampling`` is applied after the client body is copied, so it overrides
Continue for keys you set (useful for experiments).
"""

from __future__ import annotations

from typing import Any, Dict, FrozenSet, Optional

_TOP_LEVEL_SAMPLING_KEYS: FrozenSet[str] = frozenset(
    {
        "temperature",
        "top_p",
        "top_k",
        "min_p",
        "frequency_penalty",
        "presence_penalty",
        "repetition_penalty",
        "repeat_penalty",
        "max_tokens",
        "seed",
    }
)


def merge_yaml_sampling_into_chat_payload(sampling: Any, payload: Dict[str, Any]) -> None:
    """Apply ``sampling`` from YAML onto ``payload`` in place."""
    if not sampling or not isinstance(sampling, dict):
        return
    for key, val in sampling.items():
        if key == "preserve_thinking":
            if not isinstance(val, bool):
                continue
            ctk = payload.get("chat_template_kwargs")
            if not isinstance(ctk, dict):
                ctk = {}
            ctk = dict(ctk)
            ctk["preserve_thinking"] = val
            payload["chat_template_kwargs"] = ctk
            continue
        if key not in _TOP_LEVEL_SAMPLING_KEYS:
            continue
        payload[key] = val


def validate_sampling_mapping(sampling: Any, *, label: str = "sampling") -> Optional[Dict[str, Any]]:
    """Return a copy of ``sampling`` if valid, else raise ``ValueError``."""
    if sampling is None:
        return None
    if not isinstance(sampling, dict):
        raise ValueError(f"{label} must be a mapping when set")
    allowed = _TOP_LEVEL_SAMPLING_KEYS | frozenset({"preserve_thinking"})
    out: Dict[str, Any] = {}
    for k, v in sampling.items():
        if k not in allowed:
            raise ValueError(f"{label}: unknown key {k!r}; allowed: {sorted(allowed)}")
        if k == "preserve_thinking" and not isinstance(v, bool):
            raise ValueError(f"{label}: preserve_thinking must be a boolean")
        out[str(k)] = v
    return out
