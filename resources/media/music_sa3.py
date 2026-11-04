"""Stable Audio 3 Medium post-trained ComfyUI graph adapter."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from media_comfy import start_owned_comfyui
from media_job import MediaJobError, require_file, transcode_mp3


_MUSIC_KEYS = {
    "mode",
    "steps",
    "cfg",
    "sampler_name",
    "scheduler",
    "tile_size",
    "overlap",
    "mp3_bitrate_kbps",
    "negative_prompt",
    "max_seconds",
    "batch_size",
    "denoise",
    "clip_type",
    "clip_device",
    "save_format",
}


def _settings(job: dict[str, Any]) -> dict[str, Any]:
    value = job.get("music")
    if not isinstance(value, dict):
        raise MediaJobError("Job field music must be an object for Stable Audio 3.")
    missing = _MUSIC_KEYS - value.keys()
    extra = value.keys() - _MUSIC_KEYS
    if missing:
        raise MediaJobError(f"Job field music is missing: {', '.join(sorted(missing))}.")
    if extra:
        raise MediaJobError(f"Job field music has unsupported keys: {', '.join(sorted(extra))}.")
    if value["mode"] != "instrumental":
        raise MediaJobError("Stable Audio 3 adapter supports instrumental jobs only.")
    if not isinstance(value["negative_prompt"], str):
        raise MediaJobError("Job field music.negative_prompt must be a string.")
    for name in ("steps", "tile_size", "mp3_bitrate_kbps", "max_seconds", "batch_size"):
        if isinstance(value[name], bool) or not isinstance(value[name], int) or value[name] <= 0:
            raise MediaJobError(f"Job field music.{name} must be a positive integer.")
    if isinstance(value["overlap"], bool) or not isinstance(value["overlap"], int) or value["overlap"] < 0:
        raise MediaJobError("Job field music.overlap must be a nonnegative integer.")
    if value["overlap"] >= value["tile_size"]:
        raise MediaJobError("Job field music.overlap must be smaller than tile_size.")
    if value["max_seconds"] > 380:
        raise MediaJobError("Stable Audio 3 Medium max_seconds cannot exceed 380 seconds.")
    if value["batch_size"] != 1:
        raise MediaJobError("Stable Audio 3 adapter supports one output track per job.")
    if isinstance(value["denoise"], bool) or not isinstance(value["denoise"], (int, float)):
        raise MediaJobError("Job field music.denoise must be numeric.")
    if not 0 <= float(value["denoise"]) <= 1:
        raise MediaJobError("Job field music.denoise must be between 0 and 1.")
    if isinstance(value["cfg"], bool) or not isinstance(value["cfg"], (int, float)) or value["cfg"] < 0:
        raise MediaJobError("Job field music.cfg must be a nonnegative number.")
    for name in ("sampler_name", "scheduler"):
        if not isinstance(value[name], str) or not value[name].strip():
            raise MediaJobError(f"Job field music.{name} must be a non-empty string.")
    for name in ("clip_type", "clip_device", "save_format"):
        if not isinstance(value[name], str) or not value[name].strip():
            raise MediaJobError(f"Job field music.{name} must be a non-empty string.")
    if value["save_format"] != "flac":
        raise MediaJobError("Stable Audio 3 must save FLAC before MP3 export.")
    return value


def _model_name(value: Any, name: str, folder: Path) -> str:
    path = require_file(value, f"models.{name}").resolve()
    if folder.name == "checkpoints" and path.name != "stable_audio_3_medium.safetensors":
        raise MediaJobError(
            "Configured Stable Audio checkpoint must be the post-trained "
            "stable_audio_3_medium.safetensors file."
        )
    return path.name


def build_graph(job: dict[str, Any]) -> dict[str, Any]:
    music = _settings(job)
    prompt = job.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise MediaJobError("Job field prompt is required for Stable Audio 3.")
    seconds = job.get("seconds")
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or seconds <= 0:
        raise MediaJobError("Job field seconds must be a positive number for Stable Audio 3.")
    if seconds > music["max_seconds"]:
        raise MediaJobError(
            f"Stable Audio 3 duration {seconds}s exceeds the configured max_seconds {music['max_seconds']}s."
        )
    seed = job.get("seed")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise MediaJobError("Job field seed must be a nonnegative integer for Stable Audio 3.")
    models = job.get("models")
    if not isinstance(models, dict) or set(models) != {"checkpoint", "text_encoder"}:
        raise MediaJobError("Stable Audio 3 models must contain exactly checkpoint and text_encoder paths.")
    comfyui = job.get("comfyui")
    if not isinstance(comfyui, dict) or not isinstance(comfyui.get("root"), str):
        raise MediaJobError("Job field comfyui.root is required to resolve Stable Audio model filenames.")
    models_root = Path(comfyui["root"]) / "models"
    checkpoint = _model_name(models["checkpoint"], "checkpoint", models_root / "checkpoints")
    text_encoder = _model_name(models["text_encoder"], "text_encoder", models_root / "text_encoders")
    if Path(checkpoint).name != "stable_audio_3_medium.safetensors":
        raise MediaJobError(
            "Stable Audio 3 must use the configured post-trained "
            "stable_audio_3_medium.safetensors checkpoint; "
            "the post-trained checkpoint path is required for this adapter."
        )
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": text_encoder, "type": music["clip_type"], "device": music["clip_device"]},
        },
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["2", 0], "text": prompt},
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["2", 0], "text": music["negative_prompt"]},
        },
        "5": {
            "class_type": "EmptyLatentAudio",
            "inputs": {"seconds": float(seconds), "batch_size": music["batch_size"]},
        },
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "seed": seed,
                "steps": music["steps"],
                "cfg": float(music["cfg"]),
                "sampler_name": music["sampler_name"],
                "scheduler": music["scheduler"],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "latent_image": ["5", 0],
                "denoise": float(music["denoise"]),
            },
        },
        "7": {
            "class_type": "VAEDecodeAudioTiled",
            "inputs": {
                "samples": ["6", 0],
                "vae": ["1", 2],
                "tile_size": music["tile_size"],
                "overlap": music["overlap"],
            },
        },
        "8": {
            "class_type": "SaveAudioAdvanced",
            "inputs": {
                "audio": ["7", 0],
                "filename_prefix": f"forge-media/music/{job['run_id']}/track",
                "format": music["save_format"],
            },
        },
    }


def run(job: dict[str, Any]) -> dict[str, Any]:
    graph = build_graph(job)
    with start_owned_comfyui(job) as client:
        flac = client.execute(job, graph, ".flac", "track.flac")
    settings = _settings(job)
    mp3 = transcode_mp3(flac, job, settings["mp3_bitrate_kbps"])
    return {
        "output_files": [str(flac), str(mp3)],
        "details": {
            "checkpoint": str(job["models"]["checkpoint"]),
            "text_encoder": str(job["models"]["text_encoder"]),
            "sampler": settings["sampler_name"],
            "scheduler": settings["scheduler"],
            "steps": settings["steps"],
            "cfg": settings["cfg"],
            "tile_size": settings["tile_size"],
            "overlap": settings["overlap"],
            "mp3_bitrate_kbps": settings["mp3_bitrate_kbps"],
        },
    }
