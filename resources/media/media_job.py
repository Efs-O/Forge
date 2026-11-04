"""Strict JSON job runner for Forge's local media adapters.

This module deliberately has no Forge configuration dependency. The caller
resolves user configuration and writes every runtime path into job.json.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class MediaJobError(RuntimeError):
    """An actionable media job validation or execution failure."""


_JOB_KEYS = {
    "schema_version",
    "run_id",
    "run_dir",
    "kind",
    "engine",
    "prompt",
    "tool_reports",
    "seconds",
    "seed",
    "cuda_devices",
    "ffmpeg",
    "ffprobe",
    "comfyui",
    "models",
    "inputs",
    "video",
    "music",
    "ace",
    "analyzer",
}
_ENGINE_KIND = {
    "ltx25": "video",
    "h3": "video",
    "ace_step": "music",
    "stable_audio": "music",
    "flamingo_dlt": "music",
}
_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")


def _mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise MediaJobError(f"Job field {name} must be a JSON object.")
    return value


def _string(value: Any, name: str, *, nonempty: bool = True) -> str:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        qualifier = "non-empty " if nonempty else ""
        raise MediaJobError(f"Job field {name} must be a {qualifier}string.")
    return value


def _absolute_path(value: Any, name: str) -> Path:
    raw = _string(value, name)
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise MediaJobError(f"Job field {name} must be an absolute path; got {raw!r}.")
    return path


def _positive_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise MediaJobError(f"Job field {name} must be a positive number.")
    result = float(value)
    if not 0 < result < 24 * 60 * 60:
        raise MediaJobError(f"Job field {name} must be between 0 and 86400 seconds.")
    return result


def _integer(value: Any, name: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise MediaJobError(f"Job field {name} must be an integer >= {minimum}.")
    return value


def _validate_child_object(
    job: dict[str, Any], key: str, required: set[str], allowed: set[str]
) -> dict[str, Any]:
    value = _mapping(job.get(key), key)
    missing = sorted(required - value.keys())
    extra = sorted(value.keys() - allowed)
    if missing:
        raise MediaJobError(f"Job field {key} is missing: {', '.join(missing)}.")
    if extra:
        raise MediaJobError(f"Job field {key} has unsupported keys: {', '.join(extra)}.")
    return value


def validate_job(value: Any) -> dict[str, Any]:
    """Validate the versioned job envelope and its common fields."""
    job = _mapping(value, "root")
    missing = {
        "schema_version",
        "run_id",
        "run_dir",
        "kind",
        "engine",
        "cuda_devices",
        "ffmpeg",
        "ffprobe",
    } - job.keys()
    extra = job.keys() - _JOB_KEYS
    if missing:
        raise MediaJobError(f"Job is missing required fields: {', '.join(sorted(missing))}.")
    if extra:
        raise MediaJobError(f"Job has unsupported fields: {', '.join(sorted(extra))}.")
    if isinstance(job["schema_version"], bool) or job["schema_version"] != 1:
        raise MediaJobError(f"Unsupported media job schema_version {job['schema_version']!r}.")
    run_id = _string(job["run_id"], "run_id")
    if not _RUN_ID.fullmatch(run_id):
        raise MediaJobError("Job field run_id must contain only letters, digits, '_' or '-'.")
    run_dir = _absolute_path(job["run_dir"], "run_dir")
    if not run_dir.is_dir():
        raise MediaJobError(f"Job run_dir does not exist or is not a directory: {run_dir}")
    if run_dir.name != run_id:
        raise MediaJobError("Job run_dir must be named with the same value as run_id.")
    kind = _string(job["kind"], "kind")
    engine = _string(job["engine"], "engine")
    if engine not in _ENGINE_KIND:
        raise MediaJobError(f"Unsupported media engine {engine!r}.")
    if _ENGINE_KIND[engine] != kind:
        raise MediaJobError(f"Engine {engine!r} cannot run job kind {kind!r}.")
    if "prompt" in job:
        prompt = _string(job["prompt"], "prompt", nonempty=False)
        limit = 512 if engine == "ace_step" else 2000 if kind == "video" else None
        if limit is not None and len(prompt) > limit:
            raise MediaJobError(f"Job prompt exceeds the {limit}-character limit.")
    if "tool_reports" in job and (
        not isinstance(job["tool_reports"], list)
        or any(not isinstance(report, str) for report in job["tool_reports"])
    ):
        raise MediaJobError("Job field tool_reports must be an array of strings.")
    if "seconds" in job:
        _positive_number(job["seconds"], "seconds")
    if "seed" in job:
        _integer(job["seed"], "seed")
    devices = job["cuda_devices"]
    if not isinstance(devices, list) or not devices:
        raise MediaJobError("Job field cuda_devices must be a non-empty array of device indexes.")
    for index, device in enumerate(devices):
        _integer(device, f"cuda_devices[{index}]")
    if len(set(devices)) != len(devices):
        raise MediaJobError("Job field cuda_devices must not contain duplicate indexes.")
    for name in ("ffmpeg", "ffprobe"):
        if name in job:
            _string(job[name], name)
    for key in ("models", "inputs", "video", "music", "ace", "analyzer"):
        if key in job:
            _mapping(job[key], key)
    return job


def load_job(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise MediaJobError(f"Could not read media job JSON at {path}: {exc}") from exc
    return validate_job(value)


def require_file(value: Any, name: str) -> Path:
    path = _absolute_path(value, name)
    if not path.is_file():
        raise MediaJobError(f"Required file for {name} was not found: {path}")
    return path


def require_directory(value: Any, name: str) -> Path:
    path = _absolute_path(value, name)
    if not path.is_dir():
        raise MediaJobError(f"Required directory for {name} was not found: {path}")
    return path


def require_cuda_environment(job: dict[str, Any]) -> None:
    """Refuse a GPU job unless the requested device mask was set before Python started."""
    expected = ",".join(str(device) for device in job["cuda_devices"])
    actual = os.environ.get("CUDA_VISIBLE_DEVICES")
    if actual != expected:
        raise MediaJobError(
            f"CUDA_VISIBLE_DEVICES is {actual!r}; this job requires {expected!r}. "
            "Set it in the parent process before starting Python."
        )


def local_process_environment(job: dict[str, Any]) -> dict[str, str]:
    """Keep Python, framework caches, and temporary files inside the run folder."""
    run_dir = Path(job["run_dir"])
    cache_dir = run_dir / "cache"
    temp_dir = run_dir / "temp"
    pycache_dir = run_dir / "pycache"
    environment = os.environ.copy()
    environment.update(
        {
            "CUDA_VISIBLE_DEVICES": ",".join(str(device) for device in job["cuda_devices"]),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPYCACHEPREFIX": str(pycache_dir),
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "HF_HOME": str(cache_dir / "huggingface"),
            "TRANSFORMERS_CACHE": str(cache_dir / "transformers"),
            "TORCH_HOME": str(cache_dir / "torch"),
            "XDG_CACHE_HOME": str(cache_dir),
            "TMP": str(temp_dir),
            "TEMP": str(temp_dir),
            "TMPDIR": str(temp_dir),
        }
    )
    for directory in (cache_dir, temp_dir, pycache_dir):
        directory.mkdir(parents=True, exist_ok=True)
    return environment


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def run_checked(
    command: list[str],
    *,
    cwd: Path | None,
    timeout_seconds: int,
    log_path: Path,
    env: dict[str, str] | None = None,
) -> None:
    """Run one configured executable without a shell and preserve its output."""
    _integer(timeout_seconds, "timeout_seconds", minimum=1)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with log_path.open("ab") as log:
            result = subprocess.run(
                command,
                cwd=str(cwd) if cwd else None,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=timeout_seconds,
                check=False,
            )
    except subprocess.TimeoutExpired as exc:
        raise MediaJobError(f"Command timed out after {timeout_seconds}s; log: {log_path}") from exc
    except OSError as exc:
        raise MediaJobError(f"Could not start {command[0]!r}: {exc}") from exc
    if result.returncode != 0:
        tail = read_log_tail(log_path)
        raise MediaJobError(
            f"Command {command[0]!r} exited with status {result.returncode}; log: {log_path}\n{tail}"
        )


def ensure_seed(job: dict[str, Any]) -> int:
    """Use the supplied seed or create one for a request that intentionally omitted it."""
    if "seed" not in job:
        job["seed"] = random.SystemRandom().randrange(0, 2**31)
    return _integer(job["seed"], "seed")


def transcode_mp3(source: Path, job: dict[str, Any], bitrate_kbps: int) -> Path:
    bitrate = _integer(bitrate_kbps, "music.mp3_bitrate_kbps", minimum=1)
    output_dir = Path(job["run_dir"]) / "output"
    destination = output_dir / "track.mp3"
    if destination.exists():
        raise MediaJobError(f"Refusing to overwrite existing MP3 output: {destination}")
    run_checked(
        [
            _string(job.get("ffmpeg"), "ffmpeg"),
            "-hide_banner",
            "-y",
            "-i",
            str(source),
            "-codec:a",
            "libmp3lame",
            "-b:a",
            f"{bitrate}k",
            "-ar",
            "44100",
            "-ac",
            "2",
            str(destination),
        ],
        cwd=None,
        timeout_seconds=300,
        log_path=Path(job["run_dir"]) / "logs" / "ffmpeg-mp3.log",
    )
    if not destination.is_file():
        raise MediaJobError(f"ffmpeg exited successfully but did not create {destination}")
    return destination


def read_log_tail(path: Path, limit: int = 5000) -> str:
    try:
        with path.open("rb") as stream:
            stream.seek(max(0, path.stat().st_size - limit))
            return stream.read().decode("utf-8", errors="replace").strip()
    except OSError:
        return "(log tail unavailable)"


def run_ffprobe(path: Path, executable: str) -> dict[str, Any]:
    command = [
        executable,
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type",
        "-of",
        "json",
        str(path),
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise MediaJobError(f"ffprobe could not inspect {path}: {exc}") from exc
    if result.returncode != 0:
        raise MediaJobError(f"ffprobe failed for {path}: {result.stderr.strip()}")
    try:
        raw = json.loads(result.stdout)
        duration = float(raw["format"]["duration"])
        stream_types = [stream.get("codec_type") for stream in raw.get("streams", [])]
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise MediaJobError(f"ffprobe returned an invalid result for {path}: {exc}") from exc
    if not 0 < duration < 24 * 60 * 60:
        raise MediaJobError(f"ffprobe returned an invalid duration for {path}: {duration}")
    return {"duration_seconds": round(duration, 3), "has_audio": "audio" in stream_types}


def detect_silence(path: Path, executable: str) -> dict[str, Any]:
    command = [
        executable,
        "-hide_banner",
        "-nostats",
        "-i",
        str(path),
        "-af",
        "silencedetect=noise=-45dB:d=2",
        "-f",
        "null",
        "-",
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=300, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise MediaJobError(f"ffmpeg silence check could not inspect {path}: {exc}") from exc
    if result.returncode != 0:
        raise MediaJobError(f"ffmpeg silence check failed for {path}: {result.stderr.strip()}")
    matches = re.findall(r"silence_start:\s*([0-9.]+)", result.stderr)
    return {
        "result": "silence_detected" if matches else "no_silence_detected",
        "threshold_db": -45,
        "minimum_seconds": 2,
        "interval_count": len(matches),
    }


def validate_media_file(path: Path, job: dict[str, Any]) -> dict[str, Any]:
    ffprobe = _string(job.get("ffprobe"), "ffprobe")
    ffmpeg = _string(job.get("ffmpeg"), "ffmpeg")
    probe = run_ffprobe(path, ffprobe)
    silence = (
        detect_silence(path, ffmpeg)
        if probe["has_audio"]
        else {"result": "not_applicable", "reason": "no audio stream"}
    )
    return {"path": str(path), **probe, "silence": silence}


def _adapter(job: dict[str, Any]) -> dict[str, Any]:
    name = job["engine"]
    if name == "ltx25":
        from video_ltx25 import run
    elif name == "h3":
        from video_h3 import run
    elif name == "ace_step":
        from music_ace import run
    elif name == "stable_audio":
        from music_sa3 import run
    elif name == "flamingo_dlt":
        from music_analyze import run
    else:
        raise MediaJobError(f"No adapter is registered for engine {name!r}.")
    result = run(job)
    if not isinstance(result, dict):
        raise MediaJobError(f"Adapter {name!r} returned no result object.")
    return result


def run_job(job: dict[str, Any]) -> Path:
    """Run a validated adapter and atomically write its manifest after validation."""
    job = validate_job(job)
    run_dir = Path(job["run_dir"])
    for folder in ("input", "output", "logs"):
        (run_dir / folder).mkdir(exist_ok=True)
    if job["engine"] != "flamingo_dlt":
        ensure_seed(job)
    started = utc_now()
    result = _adapter(job)
    output_files = result.get("output_files", [])
    if not isinstance(output_files, list):
        raise MediaJobError(f"Adapter {job['engine']!r} returned an invalid output_files list.")
    validation_inputs = result.get("validation_inputs", [])
    if not isinstance(validation_inputs, list):
        raise MediaJobError(f"Adapter {job['engine']!r} returned an invalid validation_inputs list.")
    if not output_files and not validation_inputs:
        raise MediaJobError(f"Adapter {job['engine']!r} produced no media files to validate.")
    validations = []
    for item in output_files:
        path = _absolute_path(item, "output_files[]")
        if not path.is_file():
            raise MediaJobError(f"Adapter output does not exist: {path}")
        validations.append(validate_media_file(path, job))
    input_validations = []
    for item in validation_inputs:
        path = require_file(item, "validation_inputs[]")
        input_validations.append(validate_media_file(path, job))
    artifacts = result.get("artifacts", [])
    if not isinstance(artifacts, list):
        raise MediaJobError(f"Adapter {job['engine']!r} returned an invalid artifacts list.")
    artifact_paths = [str(require_file(item, "artifacts[]")) for item in artifacts]
    warnings = ["ffprobe duration and silence detection are gross checks, not a quality judgment."]
    if isinstance(result.get("warnings"), list):
        warnings.extend(str(item) for item in result["warnings"])
    details = result.get("details", {})
    if isinstance(details, dict) and isinstance(details.get("warnings"), list):
        warnings.extend(str(item) for item in details["warnings"])
    manifest = {
        "schema_version": 1,
        "run_id": job["run_id"],
        "kind": job["kind"],
        "engine": job["engine"],
        "status": "completed",
        "started_at": started,
        "finished_at": utc_now(),
        "prompt": job.get("prompt", ""),
        "seconds_requested": job.get("seconds"),
        "seed": job.get("seed", result.get("seed")),
        "cuda_devices": job["cuda_devices"],
        "outputs": validations,
        "source_validation": input_validations,
        "artifacts": artifact_paths,
        "details": details,
        "warnings": list(dict.fromkeys(warnings)),
    }
    if "tool_reports" in job:
        manifest["tool_reports"] = job["tool_reports"]
    manifest_path = run_dir / "manifest.json"
    write_json_atomic(manifest_path, manifest)
    return manifest_path


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as stream:
            temp_name = stream.name
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except OSError as exc:
        if temp_name:
            Path(temp_name).unlink(missing_ok=True)
        raise MediaJobError(f"Could not atomically write {path}: {exc}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run one Forge media job JSON file.")
    parser.add_argument("job", type=Path, help="absolute path to the validated job JSON")
    args = parser.parse_args(argv)
    try:
        manifest = run_job(load_job(args.job))
    except MediaJobError as exc:
        print(f"Media job failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # surfaced with a traceback for adapter defects
        print(f"Media adapter failed unexpectedly: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise
    print(f"Media job completed. Manifest: {manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
