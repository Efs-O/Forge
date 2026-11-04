"""ACE-Step 1.5 standalone vocal generation adapter."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from media_job import (
    MediaJobError,
    load_job,
    local_process_environment,
    require_cuda_environment,
    require_directory,
    require_file,
    run_checked,
    transcode_mp3,
)


_ACE_KEYS = {
    "root",
    "python",
    "checkpoints_dir",
    "config_path",
    "task_type",
    "instrumental",
    "vocal_language",
    "bpm",
    "keyscale",
    "timesignature",
    "inference_steps",
    "thinking",
    "use_cot_metas",
    "use_cot_caption",
    "use_cot_language",
    "offload_to_cpu",
    "offload_dit_to_cpu",
    "batch_size",
    "audio_format",
    "mp3_bitrate_kbps",
    "timeout_seconds",
}


def _ace_settings(job: dict[str, Any]) -> dict[str, Any]:
    value = job.get("ace")
    if not isinstance(value, dict):
        raise MediaJobError("Job field ace must be an object for ACE-Step.")
    missing = _ACE_KEYS - value.keys()
    extra = value.keys() - _ACE_KEYS
    if missing:
        raise MediaJobError(f"Job field ace is missing: {', '.join(sorted(missing))}.")
    if extra:
        raise MediaJobError(f"Job field ace has unsupported keys: {', '.join(sorted(extra))}.")
    if value["task_type"] != "text2music" or value["instrumental"] is not False:
        raise MediaJobError("ACE-Step adapter supports text2music vocal generation only.")
    if value["audio_format"] != "flac":
        raise MediaJobError("ACE-Step output must be FLAC before MP3 export.")
    for name in ("thinking", "use_cot_metas", "use_cot_caption", "use_cot_language", "offload_to_cpu", "offload_dit_to_cpu", "instrumental"):
        if not isinstance(value[name], bool):
            raise MediaJobError(f"Job field ace.{name} must be boolean.")
    for name in ("bpm", "inference_steps", "batch_size", "mp3_bitrate_kbps", "timeout_seconds"):
        if isinstance(value[name], bool) or not isinstance(value[name], int) or value[name] <= 0:
            raise MediaJobError(f"Job field ace.{name} must be a positive integer.")
    if value["batch_size"] != 1:
        raise MediaJobError("ACE-Step adapter supports one output track per job.")
    for name in ("config_path", "vocal_language", "keyscale", "timesignature"):
        if not isinstance(value[name], str) or not value[name].strip():
            raise MediaJobError(f"Job field ace.{name} must be a non-empty string.")
    return value


def _write_worker_job(job: dict[str, Any]) -> Path:
    run_dir = Path(job["run_dir"])
    fd, filename = tempfile.mkstemp(prefix=".ace-job-", suffix=".json", dir=run_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(job, stream, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except OSError:
        Path(filename).unlink(missing_ok=True)
        raise
    return Path(filename)


def run(job: dict[str, Any]) -> dict[str, Any]:
    settings = _ace_settings(job)
    require_cuda_environment(job)
    root = require_directory(settings["root"], "ace.root")
    python = require_file(settings["python"], "ace.python")
    checkpoints = require_directory(settings["checkpoints_dir"], "ace.checkpoints_dir")
    inputs = job.get("inputs")
    if not isinstance(inputs, dict) or "lyrics_path" not in inputs:
        raise MediaJobError("Job field inputs.lyrics_path is required for ACE-Step vocals.")
    lyrics = require_file(inputs["lyrics_path"], "inputs.lyrics_path")
    lyrics_text = lyrics.read_text(encoding="utf-8").strip()
    if not lyrics_text or len(lyrics_text) > 4096:
        raise MediaJobError("ACE-Step lyrics must contain 1-4096 characters.")
    caption = job.get("prompt")
    if not isinstance(caption, str) or not caption.strip() or len(caption) > 512:
        raise MediaJobError("ACE-Step prompt must contain 1-512 characters.")
    worker_job = _write_worker_job(job)
    environment = local_process_environment(job)
    environment["ACESTEP_CHECKPOINTS_DIR"] = str(checkpoints)
    try:
        run_checked(
            [str(python), str(Path(__file__).resolve()), "--worker", str(worker_job)],
            cwd=Path(job["run_dir"]),
            env=environment,
            timeout_seconds=settings["timeout_seconds"],
            log_path=Path(job["run_dir"]) / "logs" / "ace-step.log",
        )
    finally:
        worker_job.unlink(missing_ok=True)
    flac = Path(job["run_dir"]) / "output" / "track.flac"
    if not flac.is_file():
        raise MediaJobError(f"ACE-Step completed without creating the required FLAC: {flac}")
    mp3 = transcode_mp3(flac, job, settings["mp3_bitrate_kbps"])
    return {
        "output_files": [str(flac), str(mp3)],
        "details": {
            "caption": caption,
            "lyrics_path": str(lyrics),
            "runtime_root": str(root),
            "checkpoints_dir": str(checkpoints),
            "config_path": settings["config_path"],
            "duration_seconds": job["seconds"],
            "bpm": settings["bpm"],
            "keyscale": settings["keyscale"],
            "timesignature": settings["timesignature"],
            "inference_steps": settings["inference_steps"],
        },
    }


def _worker(job_path: Path) -> None:
    job = load_job(job_path)
    settings = _ace_settings(job)
    root = require_directory(settings["root"], "ace.root")
    sys.path.insert(0, str(root))
    inputs = job.get("inputs")
    if not isinstance(inputs, dict) or "lyrics_path" not in inputs:
        raise MediaJobError("Job field inputs.lyrics_path is required for ACE-Step vocals.")
    lyrics = require_file(inputs["lyrics_path"], "inputs.lyrics_path").read_text(encoding="utf-8").strip()
    caption = job.get("prompt")
    try:
        from acestep.handler import AceStepHandler
        from acestep.inference import GenerationConfig, GenerationParams, generate_music
    except ImportError as exc:
        raise MediaJobError(f"ACE-Step runtime could not be imported from {root}: {exc}") from exc
    handler = AceStepHandler()
    status, ok = handler.initialize_service(
        project_root=str(root),
        config_path=settings["config_path"],
        device="cuda",
        offload_to_cpu=settings["offload_to_cpu"],
        offload_dit_to_cpu=settings["offload_dit_to_cpu"],
    )
    print(f"ACE-Step initialization: {status}; ready={ok}", flush=True)
    if not ok:
        raise MediaJobError(f"ACE-Step initialization failed: {status}")
    seed = job.get("seed")
    params = GenerationParams(
        task_type=settings["task_type"],
        caption=caption,
        lyrics=lyrics,
        instrumental=settings["instrumental"],
        vocal_language=settings["vocal_language"],
        bpm=settings["bpm"],
        keyscale=settings["keyscale"],
        timesignature=settings["timesignature"],
        duration=job["seconds"],
        inference_steps=settings["inference_steps"],
        seed=seed,
        thinking=settings["thinking"],
        use_cot_metas=settings["use_cot_metas"],
        use_cot_caption=settings["use_cot_caption"],
        use_cot_language=settings["use_cot_language"],
    )
    config = GenerationConfig(
        batch_size=settings["batch_size"],
        audio_format=settings["audio_format"],
        use_random_seed=False,
        seeds=[seed],
    )
    output_dir = Path(job["run_dir"]) / "output"
    result = generate_music(handler, None, params, config, save_dir=str(output_dir))
    if not result.success:
        raise MediaJobError(f"ACE-Step generation failed: {result.error}")
    audios = result.audios
    if not isinstance(audios, list) or len(audios) != 1:
        raise MediaJobError("ACE-Step returned an unexpected number of audio outputs.")
    audio_path = audios[0].get("path") if isinstance(audios[0], dict) else None
    if not isinstance(audio_path, str):
        raise MediaJobError("ACE-Step returned an audio record without a path.")
    source = require_file(audio_path, "ACE-Step output")
    destination = output_dir / "track.flac"
    if source.resolve() != destination.resolve():
        if destination.exists():
            raise MediaJobError(f"Refusing to overwrite existing ACE-Step output: {destination}")
        shutil.copy2(source, destination)
    details_path = output_dir / "ace-result.json"
    details_path.write_text(
        json.dumps(
            {
                "success": result.success,
                "duration_seconds": job["seconds"],
                "seed": seed,
                "caption": caption,
                "outputs": [str(destination)],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ACE-Step worker for one Forge media job.")
    parser.add_argument("--worker", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        _worker(args.worker)
    except MediaJobError as exc:
        print(f"ACE-Step failed: {exc}", file=sys.stderr)
        return 1
    print("ACE-Step completed.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
