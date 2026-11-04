import pytest

from media_job import MediaJobError
from media_comfy import _comfy_settings, _history_files


def test_comfy_settings_requires_loopback_and_owned_folders(tmp_path):
    root = tmp_path / "ComfyUI"
    for folder in ("input", "output"):
        (root / folder).mkdir(parents=True)
    temp = tmp_path / "job-temp"
    temp.mkdir()
    user = tmp_path / "job-user"
    user.mkdir()
    settings = {
        "root": str(root),
        "python": str(tmp_path / "python.exe"),
        "host": "127.0.0.1",
        "port": 8190,
        "input_dir": str(root / "input"),
        "output_dir": str(root / "output"),
        "temp_dir": str(temp),
        "user_dir": str(user),
        "startup_args": ["--disable-auto-launch", "--lowvram"],
        "startup_timeout_seconds": 60,
        "job_timeout_seconds": 3600,
    }
    assert _comfy_settings({"comfyui": settings})["port"] == 8190
    settings["host"] = "0.0.0.0"
    with pytest.raises(MediaJobError, match="loopback"):
        _comfy_settings({"comfyui": settings})


def test_comfy_history_files_are_confined_to_output_folder(tmp_path):
    root = tmp_path / "output"
    root.mkdir()
    file = root / "clips" / "clip.mp4"
    file.parent.mkdir()
    file.write_bytes(b"owned output")
    history = {
        "outputs": {
            "75": {
                "videos": [{"filename": "clip.mp4", "subfolder": "clips", "type": "output"}]
            }
        }
    }
    assert _history_files(history, root) == [file.resolve()]
    outside = tmp_path / "private.mp4"
    outside.write_bytes(b"not an output")
    traversal = {
        "outputs": {"75": {"videos": [{"filename": "private.mp4", "subfolder": "..", "type": "output"}]}}
    }
    with pytest.raises(MediaJobError, match="outside output_dir"):
        _history_files(traversal, root)
