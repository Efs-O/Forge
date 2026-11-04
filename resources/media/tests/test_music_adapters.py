from contextlib import nullcontext
from pathlib import Path

import pytest

from media_job import MediaJobError
import music_sa3
from music_analyze import _extract_fields, _source_audio
from music_sa3 import build_graph


def _sa3_job(tmp_path, checkpoint_name="stable_audio_3_medium.safetensors"):
    run_dir = tmp_path / "sa3-test"
    run_dir.mkdir(exist_ok=True)
    root = tmp_path / "comfyui"
    checkpoint = root / "models" / "checkpoints" / checkpoint_name
    encoder = root / "models" / "text_encoders" / "t5gemma.safetensors"
    for path in (checkpoint, encoder):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture", encoding="utf-8")
    return {
        "run_id": "sa3-test",
        "run_dir": str(run_dir),
        "engine": "stable_audio",
        "prompt": "Instrumental synth pop with a steady midtempo groove.",
        "seconds": 30,
        "seed": 19,
        "comfyui": {"root": str(root)},
        "models": {"checkpoint": str(checkpoint), "text_encoder": str(encoder)},
        "music": {
            "mode": "instrumental",
            "steps": 8,
            "cfg": 1,
            "sampler_name": "lcm",
            "scheduler": "simple",
            "tile_size": 256,
            "overlap": 32,
            "mp3_bitrate_kbps": 320,
            "negative_prompt": "vocals, singing, spoken words, lyrics",
            "max_seconds": 380,
            "batch_size": 1,
            "denoise": 1,
            "clip_type": "stable_audio",
            "clip_device": "default",
            "save_format": "flac",
        },
    }


def test_sa3_graph_uses_post_trained_checkpoint_and_proven_settings(tmp_path):
    graph = build_graph(_sa3_job(tmp_path))
    assert graph["1"]["inputs"]["ckpt_name"] == "stable_audio_3_medium.safetensors"
    assert graph["5"]["inputs"] == {"seconds": 30.0, "batch_size": 1}
    assert graph["6"]["inputs"]["steps"] == 8
    assert graph["6"]["inputs"]["cfg"] == 1.0
    assert graph["6"]["inputs"]["sampler_name"] == "lcm"
    assert graph["6"]["inputs"]["scheduler"] == "simple"
    assert graph["7"]["inputs"]["tile_size"] == 256
    assert graph["7"]["inputs"]["overlap"] == 32
    assert graph["8"]["inputs"]["format"] == "flac"


def test_sa3_rejects_base_checkpoint_and_duration_over_configured_cap(tmp_path):
    with pytest.raises(MediaJobError, match="post-trained"):
        build_graph(_sa3_job(tmp_path, "stable_audio_3_medium_base.safetensors"))
    job = _sa3_job(tmp_path)
    job["seconds"] = 381
    with pytest.raises(MediaJobError, match="exceeds the configured"):
        build_graph(job)


def test_flamingo_analysis_extracts_estimated_fields_without_claiming_transcription():
    fields = _extract_fields(
        "Tempo: 118 BPM\nKey: A minor\nMood: reflective\nInstruments: synths, guitar",
        [],
    )
    assert fields == {
        "tempo_bpm": 118,
        "key": "A minor",
        "mood": "reflective",
        "instruments": "synths, guitar",
    }


def test_flamingo_accepts_supported_audio_containers_and_refuses_other_files(tmp_path):
    source = tmp_path / "voice.ogg"
    source.write_bytes(b"audio")
    assert _source_audio({"inputs": {"source_audio_path": str(source)}}) == source

    unsupported = tmp_path / "notes.txt"
    unsupported.write_text("not audio", encoding="utf-8")
    with pytest.raises(MediaJobError, match="supported audio source"):
        _source_audio({"inputs": {"source_audio_path": str(unsupported)}})


def test_sa3_run_uses_fake_comfy_and_fake_mp3_export(tmp_path, monkeypatch):
    job = _sa3_job(tmp_path)
    output = Path(job["run_dir"]) / "output" / "track.flac"

    class FakeClient:
        def execute(self, received_job, graph, suffix, name):
            assert graph["1"]["inputs"]["ckpt_name"] == "stable_audio_3_medium.safetensors"
            assert suffix == ".flac"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"fake audio")
            return output

    def fake_mp3(source, received_job, bitrate):
        assert source == output
        assert bitrate == 320
        destination = output.parent / "track.mp3"
        destination.write_bytes(b"fake mp3")
        return destination

    monkeypatch.setattr(music_sa3, "start_owned_comfyui", lambda _: nullcontext(FakeClient()))
    monkeypatch.setattr(music_sa3, "transcode_mp3", fake_mp3)
    result = music_sa3.run(job)
    assert result["output_files"] == [str(output), str(output.parent / "track.mp3")]
