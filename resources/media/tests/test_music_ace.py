import pytest

from media_job import MediaJobError
import music_ace
from music_ace import _ace_settings
from music_analyze import _analyzer_settings


def _settings():
    return {
        "root": "C:/ACE-Step-1.5",
        "python": "C:/ACE-Step-1.5/.venv/Scripts/python.exe",
        "checkpoints_dir": "C:/models/ACE-Step-1.5",
        "config_path": "acestep-v15-turbo",
        "task_type": "text2music",
        "instrumental": False,
        "vocal_language": "en",
        "bpm": 120,
        "keyscale": "B Major",
        "timesignature": "4",
        "inference_steps": 8,
        "thinking": False,
        "use_cot_metas": False,
        "use_cot_caption": False,
        "use_cot_language": False,
        "offload_to_cpu": True,
        "offload_dit_to_cpu": False,
        "batch_size": 1,
        "audio_format": "flac",
        "mp3_bitrate_kbps": 320,
        "timeout_seconds": 3600,
    }


def test_ace_settings_match_vocal_recipe_and_require_single_flac_output():
    assert _ace_settings({"ace": _settings()})["task_type"] == "text2music"
    bad = _settings()
    bad["task_type"] = "cover"
    with pytest.raises(MediaJobError, match="text2music vocal"):
        _ace_settings({"ace": bad})
    bad = _settings()
    bad["batch_size"] = 2
    with pytest.raises(MediaJobError, match="one output track"):
        _ace_settings({"ace": bad})


def test_flamingo_settings_require_one_job_and_a_timeout():
    value = {
        "launcher": "C:/Flamingo/Start-DLT.ps1",
        "python": "C:/Flamingo/.venv/Scripts/python.exe",
        "powershell": "powershell.exe",
        "limit": 1,
        "timeout_seconds": 3600,
    }
    assert _analyzer_settings({"analyzer": value})["limit"] == 1
    value["limit"] = 2
    with pytest.raises(MediaJobError, match="exactly one"):
        _analyzer_settings({"analyzer": value})


def test_ace_run_uses_fake_worker_and_mp3_export(tmp_path, monkeypatch):
    run_dir = tmp_path / "ace-test"
    run_dir.mkdir()
    root = tmp_path / "ACE-Step-1.5"
    root.mkdir()
    checkpoints = tmp_path / "ace-checkpoints"
    checkpoints.mkdir()
    python = tmp_path / "python.exe"
    python.write_text("fake", encoding="utf-8")
    lyrics = run_dir / "lyrics.txt"
    lyrics.write_text("A new song in generic words.", encoding="utf-8")
    job = {
        "run_id": run_dir.name,
        "run_dir": str(run_dir),
        "engine": "ace_step",
        "seconds": 30,
        "seed": 12,
        "cuda_devices": [2],
        "prompt": "Gentle indie folk with piano and soft percussion.",
        "inputs": {"lyrics_path": str(lyrics)},
        "ace": {
            **_settings(),
            "root": str(root),
            "python": str(python),
            "checkpoints_dir": str(checkpoints),
        },
    }

    def fake_worker(command, **kwargs):
        assert command[0] == str(python)
        assert kwargs["env"]["ACESTEP_CHECKPOINTS_DIR"] == str(checkpoints)
        (run_dir / "output").mkdir(exist_ok=True)
        (run_dir / "output" / "track.flac").write_bytes(b"fake audio")

    def fake_mp3(source, received_job, bitrate):
        assert source.name == "track.flac"
        assert bitrate == 320
        destination = run_dir / "output" / "track.mp3"
        destination.write_bytes(b"fake mp3")
        return destination

    monkeypatch.setattr(music_ace, "require_cuda_environment", lambda _: None)
    monkeypatch.setattr(music_ace, "local_process_environment", lambda _: {})
    monkeypatch.setattr(music_ace, "run_checked", fake_worker)
    monkeypatch.setattr(music_ace, "transcode_mp3", fake_mp3)
    result = music_ace.run(job)
    assert result["output_files"] == [
        str(run_dir / "output" / "track.flac"),
        str(run_dir / "output" / "track.mp3"),
    ]
