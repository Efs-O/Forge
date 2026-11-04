"""LTX-2.5 distilled image-to-video ComfyUI graph adapter."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from media_comfy import remove_staged_input, stage_input, start_owned_comfyui
from media_job import MediaJobError, require_file


_MODEL_NODES = {
    "diffusion": ("100413", "unet_name"),
    "video_vae": ("100385", "vae_name"),
    "audio_vae": ("100386", "vae_name"),
    "text_encoder": ("100387", "clip_name"),
    "latent_upscaler": ("100371", "model_name"),
}
_VIDEO_KEYS = {
    "width",
    "height",
    "fps",
    "image_compression",
    "base_strength",
    "refine_strength",
    "prompt_enhance",
    "negative_prompt",
}


def _required_mapping(value: Any, name: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise MediaJobError(f"Job field {name} must be an object.")
    missing = keys - value.keys()
    extra = value.keys() - keys
    if missing:
        raise MediaJobError(f"Job field {name} is missing: {', '.join(sorted(missing))}.")
    if extra:
        raise MediaJobError(f"Job field {name} has unsupported keys: {', '.join(sorted(extra))}.")
    return value


def _positive_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise MediaJobError(f"Job field {name} must be a positive integer.")
    return value


def _model_name(value: Any, name: str, models_root: Path) -> str:
    path = require_file(value, f"models.{name}").resolve()
    try:
        relative = path.relative_to(models_root.resolve())
    except ValueError as exc:
        raise MediaJobError(
            f"Configured {name} model must be inside ComfyUI's configured models folder "
            f"{models_root}; got {path}."
        ) from exc
    return relative.name


def build_graph(job: dict[str, Any], image_name: str) -> dict[str, Any]:
    video = _required_mapping(job.get("video"), "video", _VIDEO_KEYS)
    models = job.get("models")
    if not isinstance(models, dict):
        raise MediaJobError("Job field models must be an object.")
    required_models = set(_MODEL_NODES)
    optional_models = {"prompt_enhancer"}
    missing = required_models - models.keys()
    extra = models.keys() - (required_models | optional_models)
    if missing:
        raise MediaJobError(f"Job field models is missing: {', '.join(sorted(missing))}.")
    if extra:
        raise MediaJobError(f"Job field models has unsupported keys: {', '.join(sorted(extra))}.")
    comfyui = job.get("comfyui")
    if not isinstance(comfyui, dict) or not isinstance(comfyui.get("root"), str):
        raise MediaJobError("Job field comfyui.root is required to resolve model filenames.")
    models_root = Path(comfyui["root"]) / "models"
    graph_path = Path(__file__).with_name("video_ltx25_api_skeleton.json")
    try:
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise MediaJobError(f"Could not load the bundled LTX-2.5 API skeleton at {graph_path}: {exc}") from exc
    if not isinstance(graph, dict):
        raise MediaJobError("The bundled LTX-2.5 API skeleton must be a JSON object.")
    graph = copy.deepcopy(graph)
    width = _positive_int(video["width"], "video.width")
    height = _positive_int(video["height"], "video.height")
    fps = _positive_int(video["fps"], "video.fps")
    if width % 64 or height % 64:
        raise MediaJobError(
            "LTX-2.5 width and height must be multiples of 64; choose a supported size explicitly."
        )
    seconds = job.get("seconds")
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or seconds <= 0:
        raise MediaJobError("Job field seconds must be a positive number for LTX-2.5.")
    frames = round(float(seconds) * fps) + 1
    if frames < 9 or (frames - 1) % 8:
        raise MediaJobError(
            f"LTX-2.5 frame count {frames} is unsupported; duration × fps must produce 8k+1 frames."
        )
    prompt = job.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise MediaJobError("Job field prompt is required for LTX-2.5.")
    seed = job.get("seed")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise MediaJobError("Job field seed must be a nonnegative integer for LTX-2.5.")
    for name, (node_id, input_name) in _MODEL_NODES.items():
        node = graph.get(node_id)
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            raise MediaJobError(f"LTX-2.5 API skeleton is missing model node {node_id}.")
        node["inputs"][input_name] = _model_name(models[name], name, models_root)
    if video["prompt_enhance"]:
        if "prompt_enhancer" not in models:
            raise MediaJobError(
                "video.prompt_enhance requires the configured models.prompt_enhancer path."
            )
        graph["100393"]["inputs"]["clip_name"] = _model_name(
            models["prompt_enhancer"], "prompt_enhancer", models_root
        )
    else:
        # ComfyUI validates every node's selector even though this switch branch is lazy.
        graph["100393"]["inputs"]["clip_name"] = _model_name(
            models["text_encoder"], "text_encoder", models_root
        )
    compression = _positive_int(video["image_compression"], "video.image_compression")
    for name in ("base_strength", "refine_strength"):
        if isinstance(video[name], bool) or not isinstance(video[name], (int, float)):
            raise MediaJobError(f"Job field video.{name} must be numeric.")
        if not 0 <= float(video[name]) <= 1:
            raise MediaJobError(f"Job field video.{name} must be between 0 and 1.")
    if not isinstance(video["prompt_enhance"], bool):
        raise MediaJobError("Job field video.prompt_enhance must be boolean.")
    if not isinstance(video["negative_prompt"], str):
        raise MediaJobError("Job field video.negative_prompt must be a string.")
    graph["395"]["inputs"]["image"] = image_name
    graph["75"]["inputs"]["filename_prefix"] = f"forge-media/video/{job['run_id']}/clip"
    graph["100376"]["inputs"]["value"] = prompt
    graph["100372"]["inputs"]["value"] = width
    graph["100360"]["inputs"]["value"] = height
    graph["100361"]["inputs"]["value"] = fps
    graph["100356"]["inputs"]["length"] = frames
    graph["100366"]["inputs"]["frames_number"] = frames
    graph["100383"]["inputs"]["value"] = video["prompt_enhance"]
    graph["100338"]["inputs"]["noise_seed"] = seed
    graph["100339"]["inputs"]["noise_seed"] = seed + 1
    graph["100350"]["inputs"]["img_compression"] = compression
    graph["100357"]["inputs"]["strength"] = float(video["base_strength"])
    graph["100349"]["inputs"]["strength"] = float(video["refine_strength"])
    graph["100373"]["inputs"]["text"] = video["negative_prompt"]
    return graph


def run(job: dict[str, Any]) -> dict[str, Any]:
    inputs = job.get("inputs")
    if not isinstance(inputs, dict) or "image_path" not in inputs:
        raise MediaJobError("Job field inputs.image_path is required for LTX-2.5.")
    source = require_file(inputs["image_path"], "inputs.image_path")
    image_name = stage_input(job, str(source), "inputs.image_path")
    try:
        graph = build_graph(job, image_name)
        with start_owned_comfyui(job) as client:
            output = client.execute(job, graph, ".mp4", "clip.mp4")
    finally:
        remove_staged_input(job, image_name)
    return {
        "output_files": [str(output)],
        "details": {
            "image_path": str(source),
            "frames": graph["100356"]["inputs"]["length"],
            "models": {name: str(path) for name, path in job["models"].items()},
            "video": job["video"],
        },
    }
