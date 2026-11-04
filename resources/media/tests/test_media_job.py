import json
from pathlib import Path

import pytest

import media_job
from media_job import MediaJobError, load_job, run_job, validate_job, write_json_atomic


def _job(base_dir):
    run_dir = base_dir / "test-run_1"
    run_dir.mkdir(exist_ok=True)
    return {
        "schema_version": 1,
        "run_id": "test-run_1",
        "run_dir": str(run_dir),
        "kind": "video",
        "engine": "ltx25",
        "prompt": "A neutral scene with gentle camera movement.",
        "seconds": 5,
        "seed": 7,
        "cuda_devices": [2],
        "ffmpeg": "ffmpeg",
        "ffprobe": "ffprobe",
    }


def test_job_accepts_known_version_and_absolute_existing_run_folder(tmp_path):
    assert validate_job(_job(tmp_path))["engine"] == "ltx25"


def test_job_rejects_unknown_fields_and_invalid_engine_kind(tmp_path):
    value = _job(tmp_path)
    value["config_yaml"] = "not allowed"
    with pytest.raises(MediaJobError, match="unsupported fields"):
        validate_job(value)

    value = _job(tmp_path)
    value["kind"] = "music"
    with pytest.raises(MediaJobError, match="cannot run job kind"):
        validate_job(value)


def test_job_rejects_duplicate_devices_and_ace_caption_but_accepts_long_sa3_prompt(tmp_path):
    value = _job(tmp_path)
    value["cuda_devices"] = [2, 2]
    with pytest.raises(MediaJobError, match="duplicate"):
        validate_job(value)

    value = _job(tmp_path)
    value.update(kind="music", engine="ace_step", prompt="x" * 513)
    with pytest.raises(MediaJobError, match="512-character"):
        validate_job(value)

    value = _job(tmp_path)
    value.update(kind="music", engine="stable_audio", prompt="x" * 10_000)
    assert len(validate_job(value)["prompt"]) == 10_000


def test_load_job_reports_path_and_json_errors(tmp_path):
    with pytest.raises(MediaJobError, match="Could not read media job JSON"):
        load_job(tmp_path / "missing.json")
    malformed = tmp_path / "malformed.json"
    malformed.write_text("{", encoding="utf-8")
    with pytest.raises(MediaJobError, match="Could not read media job JSON"):
        load_job(malformed)


def test_manifest_json_write_is_atomic_and_utf8(tmp_path):
    destination = tmp_path / "nested" / "manifest.json"
    write_json_atomic(destination, {"status": "completed", "note": "café"})
    assert json.loads(destination.read_text(encoding="utf-8"))["note"] == "café"
    assert not list(destination.parent.glob("*.tmp"))


def test_runner_writes_manifest_only_after_fake_output_validation(tmp_path, monkeypatch):
    job = _job(tmp_path)
    job["tool_reports"] = ['Removed vocal sentence: "A singer enters."']
    output = Path(job["run_dir"]) / "output" / "clip.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"fake video")
    events = []

    def fake_adapter(received_job):
        events.append("adapter")
        return {"output_files": [str(output)], "details": {"test": True}}

    def fake_validation(path, received_job):
        events.append("validation")
        assert not (Path(job["run_dir"]) / "manifest.json").exists()
        return {"path": str(path), "duration_seconds": 5.0, "silence": {"result": "not_applicable"}}

    monkeypatch.setattr(media_job, "_adapter", fake_adapter)
    monkeypatch.setattr(media_job, "validate_media_file", fake_validation)
    manifest_path = run_job(job)
    assert events == ["adapter", "validation"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["status"] == "completed"
    assert manifest["tool_reports"] == job["tool_reports"]
