from contextlib import nullcontext
from pathlib import Path

import pytest

from media_job import MediaJobError
import video_ltx25
from video_ltx25 import build_graph


def _job(tmp_path, width=1344):
    run_dir = tmp_path / "ltx-test"
    run_dir.mkdir(exist_ok=True)
    root = tmp_path / "comfyui"
    models_root = root / "models"
    model_paths = {
        "diffusion": models_root / "diffusion_models" / "ltx.gguf",
        "video_vae": models_root / "vae" / "video.safetensors",
        "audio_vae": models_root / "vae" / "audio.safetensors",
        "text_encoder": models_root / "text_encoders" / "encoder.safetensors",
        "latent_upscaler": models_root / "latent_upscale_models" / "upscaler.safetensors",
    }
    for path in model_paths.values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture", encoding="utf-8")
    return {
        "run_id": "ltx-test",
        "run_dir": str(run_dir),
        "engine": "ltx25",
        "prompt": "Slow lateral camera movement over a neutral landscape.",
        "seconds": 5,
        "seed": 17,
        "comfyui": {"root": str(root)},
        "models": {name: str(path) for name, path in model_paths.items()},
        "video": {
            "width": width,
            "height": 768,
            "fps": 24,
            "image_compression": 10,
            "base_strength": 0.7,
            "refine_strength": 1.0,
            "prompt_enhance": False,
            "negative_prompt": "",
        },
    }


def test_ltx_graph_uses_configured_model_paths_and_computes_5s_24fps(tmp_path):
    graph = build_graph(_job(tmp_path), "forge_ltx-test_still.png")
    assert graph["100413"]["inputs"]["unet_name"] == "ltx.gguf"
    assert graph["100385"]["inputs"]["vae_name"] == "video.safetensors"
    assert graph["100386"]["inputs"]["vae_name"] == "audio.safetensors"
    assert graph["100387"]["inputs"]["clip_name"] == "encoder.safetensors"
    assert graph["100371"]["inputs"]["model_name"] == "upscaler.safetensors"
    assert graph["100356"]["inputs"]["length"] == 121
    assert graph["100366"]["inputs"]["frames_number"] == 121
    assert graph["395"]["inputs"]["image"] == "forge_ltx-test_still.png"
    assert graph["100393"]["inputs"]["clip_name"] == "encoder.safetensors"


def test_ltx_rejects_width_that_is_not_supported_instead_of_rounding(tmp_path):
    with pytest.raises(MediaJobError, match="multiples of 64"):
        build_graph(_job(tmp_path, width=1360), "still.png")


def test_ltx_requires_enhancer_model_when_prompt_enhance_is_enabled(tmp_path):
    job = _job(tmp_path)
    job["video"]["prompt_enhance"] = True
    with pytest.raises(MediaJobError, match="models.prompt_enhancer"):
        build_graph(job, "still.png")


def test_ltx_run_uses_fake_comfy_and_stages_only_the_configured_still(tmp_path, monkeypatch):
    job = _job(tmp_path)
    image = tmp_path / "neutral.png"
    image.write_bytes(b"fake test input")
    job["inputs"] = {"image_path": str(image)}
    output = Path(job["run_dir"]) / "output" / "clip.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)

    class FakeClient:
        def execute(self, received_job, graph, suffix, name):
            assert received_job is job
            assert graph["395"]["inputs"]["image"] == "staged.png"
            assert suffix == ".mp4"
            output.write_bytes(b"fake video")
            return output

    monkeypatch.setattr(video_ltx25, "stage_input", lambda *args: "staged.png")
    monkeypatch.setattr(video_ltx25, "remove_staged_input", lambda *args: None)
    monkeypatch.setattr(video_ltx25, "start_owned_comfyui", lambda _: nullcontext(FakeClient()))
    assert video_ltx25.run(job)["output_files"] == [str(output)]
