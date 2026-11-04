"""Music Flamingo DLT analysis adapter for a workspace audio input."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from media_job import (
    MediaJobError,
    require_cuda_environment,
    require_file,
    run_checked,
    write_json_atomic,
)


_ANALYZER_KEYS = {"launcher", "python", "powershell", "limit", "timeout_seconds"}
_SUPPORTED_AUDIO_SUFFIXES = {".aac", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav", ".webm"}
_FIELD_PATTERNS = {
    "tempo_bpm": re.compile(r"\b(?:tempo|bpm)\s*[:=\-]?\s*(\d{2,3}(?:\.\d+)?)", re.I),
    "key": re.compile(r"\bkey\s*[:=\-]?\s*([A-G](?:#|b)?\s*(?:major|minor))", re.I),
    "mood": re.compile(r"\bmood\s*[:=\-]?\s*([^\r\n]+)", re.I),
    "instruments": re.compile(r"\binstruments?\s*[:=\-]?\s*([^\r\n]+)", re.I),
    "structure": re.compile(r"\bstructure\s*[:=\-]?\s*([^\r\n]+)", re.I),
}


def _analyzer_settings(job: dict[str, Any]) -> dict[str, Any]:
    value = job.get("analyzer")
    if not isinstance(value, dict):
        raise MediaJobError("Job field analyzer must be an object for Flamingo DLT.")
    missing = _ANALYZER_KEYS - value.keys()
    extra = value.keys() - _ANALYZER_KEYS
    if missing:
        raise MediaJobError(f"Job field analyzer is missing: {', '.join(sorted(missing))}.")
    if extra:
        raise MediaJobError(f"Job field analyzer has unsupported keys: {', '.join(sorted(extra))}.")
    for name in ("limit", "timeout_seconds"):
        if isinstance(value[name], bool) or not isinstance(value[name], int) or value[name] <= 0:
            raise MediaJobError(f"Job field analyzer.{name} must be a positive integer.")
    if value["limit"] != 1:
        raise MediaJobError("Flamingo DLT media jobs process exactly one source file.")
    return value


def _source_audio(job: dict[str, Any]) -> Path:
    inputs = job.get("inputs")
    if not isinstance(inputs, dict) or "source_audio_path" not in inputs:
        raise MediaJobError("Job field inputs.source_audio_path is required for Flamingo DLT.")
    source = require_file(inputs["source_audio_path"], "inputs.source_audio_path")
    if source.suffix.lower() not in _SUPPORTED_AUDIO_SUFFIXES:
        raise MediaJobError(f"Flamingo DLT requires a supported audio source file; got {source.suffix!r}.")
    return source


def _extract_fields(raw_text: str, records: list[Any]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for record in records:
        if not isinstance(record, dict):
            continue
        for key in _FIELD_PATTERNS:
            value = record.get(key)
            if value is not None:
                fields[key] = value
    for name, pattern in _FIELD_PATTERNS.items():
        if name in fields:
            continue
        match = pattern.search(raw_text)
        if match:
            value: Any = match.group(1).strip()
            if name == "tempo_bpm":
                try:
                    value = float(value)
                except ValueError:
                    continue
                if value.is_integer():
                    value = int(value)
            fields[name] = value
    return fields


def _read_outputs(output_root: Path, log_path: Path) -> tuple[str, list[Any]]:
    text_parts: list[str] = []
    records: list[Any] = []
    for path in sorted(output_root.rglob("*.txt")) + sorted(output_root.rglob("*.md")):
        if path.is_file():
            text_parts.append(path.read_text(encoding="utf-8", errors="replace"))
    for path in sorted(output_root.rglob("*.json")):
        if path.is_file():
            try:
                records.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise MediaJobError(f"Flamingo output JSON is unreadable at {path}: {exc}") from exc
    if log_path.is_file():
        text_parts.append(log_path.read_text(encoding="utf-8", errors="replace"))
    raw_text = "\n\n".join(part for part in text_parts if part.strip()).strip()
    if not raw_text and not records:
        raise MediaJobError("Flamingo completed without a text or JSON analysis result.")
    return raw_text, records


def _start_and_stop(
    settings: dict[str, Any],
    source_dir: Path,
    output_root: Path,
    run_dir: Path,
) -> None:
    launcher = require_file(settings["launcher"], "analyzer.launcher")
    python = require_file(settings["python"], "analyzer.python")
    powershell = settings["powershell"]
    if not isinstance(powershell, str) or not powershell.strip():
        raise MediaJobError("Job field analyzer.powershell must be a non-empty executable path.")
    start_command = [
        powershell,
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(launcher),
        "-Source",
        str(source_dir),
        "-OutputRoot",
        str(output_root),
        "-Python",
        str(python),
        "-Limit",
        str(settings["limit"]),
    ]
    stop_command = [
        powershell,
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(launcher),
        "-Python",
        str(python),
        "-Stop",
    ]
    start_failure: Exception | None = None
    stop_failure: Exception | None = None
    try:
        run_checked(
            start_command,
            cwd=run_dir,
            timeout_seconds=settings["timeout_seconds"],
            log_path=run_dir / "logs" / "flamingo-start.log",
        )
    except Exception as exc:
        start_failure = exc
    try:
        # The launcher can leave a resident worker after its task exits.
        run_checked(
            stop_command,
            cwd=run_dir,
            timeout_seconds=120,
            log_path=run_dir / "logs" / "flamingo-stop.log",
        )
    except Exception as exc:
        stop_failure = exc
    if start_failure and stop_failure:
        raise MediaJobError(f"Flamingo start failed ({start_failure}); worker stop also failed ({stop_failure}).")
    if start_failure:
        raise start_failure
    if stop_failure:
        raise stop_failure


def run(job: dict[str, Any]) -> dict[str, Any]:
    require_cuda_environment(job)
    settings = _analyzer_settings(job)
    source = _source_audio(job)
    ffmpeg = job.get("ffmpeg")
    if not isinstance(ffmpeg, str) or not ffmpeg.strip():
        raise MediaJobError("Job field ffmpeg is required to prepare the Flamingo 16 kHz WAV.")
    run_dir = Path(job["run_dir"])
    source_dir = run_dir / "input" / "flamingo-source"
    output_root = run_dir / "output" / "flamingo"
    source_dir.mkdir(parents=True, exist_ok=False)
    output_root.mkdir(parents=True, exist_ok=False)
    wav_path = source_dir / "source.wav"
    run_checked(
        [
            ffmpeg,
            "-hide_banner",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(wav_path),
        ],
        cwd=run_dir,
        timeout_seconds=300,
        log_path=run_dir / "logs" / "flamingo-convert.log",
    )
    _start_and_stop(settings, source_dir, output_root, run_dir)
    raw_text, records = _read_outputs(output_root, run_dir / "logs" / "flamingo-start.log")
    fields = _extract_fields(raw_text, records)
    analysis_path = run_dir / "output" / "analysis.json"
    analysis = {
        "schema_version": 1,
        "engine": "flamingo_dlt",
        "source_audio_path": str(source),
        "raw_text": raw_text,
        "raw_records": records,
        "fields": fields,
        "warnings": [
            "BPM and key values from Music Flamingo are estimates.",
            "Music Flamingo analysis does not transcribe lyrics.",
        ],
    }
    write_json_atomic(analysis_path, analysis)
    return {
        "output_files": [],
        "validation_inputs": [str(source)],
        "artifacts": [str(analysis_path)],
        "details": {
            "analysis_path": str(analysis_path),
            "fields": fields,
            "warnings": analysis["warnings"],
        },
    }
