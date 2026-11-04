"""Owned ComfyUI process and local API helpers for media jobs."""

from __future__ import annotations

import contextlib
import ctypes
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterator

from media_job import (
    MediaJobError,
    local_process_environment,
    read_log_tail,
    require_cuda_environment,
    require_directory,
    require_file,
)


_COMFY_KEYS = {
    "root",
    "python",
    "host",
    "port",
    "input_dir",
    "output_dir",
    "temp_dir",
    "user_dir",
    "startup_args",
    "startup_timeout_seconds",
    "job_timeout_seconds",
}


def _comfy_settings(job: dict[str, Any]) -> dict[str, Any]:
    settings = job.get("comfyui")
    if not isinstance(settings, dict):
        raise MediaJobError("Job field comfyui must be an object.")
    missing = _COMFY_KEYS - settings.keys()
    extra = settings.keys() - _COMFY_KEYS
    if missing:
        raise MediaJobError(f"Job field comfyui is missing: {', '.join(sorted(missing))}.")
    if extra:
        raise MediaJobError(f"Job field comfyui has unsupported keys: {', '.join(sorted(extra))}.")
    host = settings["host"]
    try:
        address = ipaddress.ip_address(host)
        if address.version != 4 or not address.is_loopback:
            raise MediaJobError("ComfyUI host must be a loopback IP address.")
    except (ValueError, TypeError) as exc:
        raise MediaJobError("ComfyUI host must be a loopback IP address.") from exc
    if not isinstance(settings["port"], int) or isinstance(settings["port"], bool):
        raise MediaJobError("ComfyUI port must be an integer.")
    if not 1 <= settings["port"] <= 65535:
        raise MediaJobError("ComfyUI port must be between 1 and 65535.")
    for key in ("startup_timeout_seconds", "job_timeout_seconds"):
        if not isinstance(settings[key], int) or isinstance(settings[key], bool) or settings[key] < 1:
            raise MediaJobError(f"ComfyUI {key} must be a positive integer.")
    args = settings["startup_args"]
    if not isinstance(args, list) or any(not isinstance(item, str) for item in args):
        raise MediaJobError("ComfyUI startup_args must be an array of strings.")
    if any(arg in ("--listen", "--port") or arg.startswith(("--listen=", "--port=")) for arg in args):
        raise MediaJobError("Set ComfyUI listen and port in the job fields, not startup_args.")
    return settings


def _port_is_available(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, port))
        except OSError:
            return False
    return True


def _create_kill_on_close_job(process: subprocess.Popen[bytes]) -> int:
    if os.name != "nt":
        raise MediaJobError("Owned ComfyUI rendering requires Windows job-object cleanup.")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel32.CreateJobObjectW
    create.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    create.restype = ctypes.c_void_p
    handle = create(None, None)
    if not handle:
        raise MediaJobError(f"CreateJobObjectW failed: {ctypes.get_last_error()}.")

    class BasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", ctypes.c_uint32),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", ctypes.c_uint32),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", ctypes.c_uint32),
            ("SchedulingClass", ctypes.c_uint32),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(field, ctypes.c_uint64) for field in (
            "ReadOperationCount",
            "WriteOperationCount",
            "OtherOperationCount",
            "ReadTransferCount",
            "WriteTransferCount",
            "OtherTransferCount",
        )]

    class ExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimitInformation),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    info = ExtendedLimitInformation()
    info.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    set_info = kernel32.SetInformationJobObject
    set_info.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    set_info.restype = ctypes.c_int
    if not set_info(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
        error = ctypes.get_last_error()
        kernel32.CloseHandle(handle)
        raise MediaJobError(f"SetInformationJobObject failed: {error}.")
    assign = kernel32.AssignProcessToJobObject
    assign.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    assign.restype = ctypes.c_int
    if not assign(handle, ctypes.c_void_p(int(process._handle))):
        error = ctypes.get_last_error()
        kernel32.CloseHandle(handle)
        raise MediaJobError(f"AssignProcessToJobObject failed: {error}.")
    return int(handle)


def _close_job(handle: int | None) -> None:
    if handle is not None and os.name == "nt":
        ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle(ctypes.c_void_p(handle))


class ComfyClient:
    def __init__(self, host: str, port: int, timeout_seconds: int) -> None:
        self.base_url = f"http://{host}:{port}"
        self.timeout_seconds = timeout_seconds

    def request_json(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers={"Content-Type": "application/json"} if data is not None else {},
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read()
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:2000]
            raise MediaJobError(
                f"ComfyUI {method} {path} failed at {self.base_url} with HTTP {exc.code}: {body}"
            ) from exc
        except (OSError, urllib.error.URLError) as exc:
            raise MediaJobError(f"ComfyUI {method} {path} failed at {self.base_url}: {exc}") from exc
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise MediaJobError(f"ComfyUI {method} {path} returned invalid JSON.") from exc

    def execute(self, job: dict[str, Any], graph: dict[str, Any], suffix: str, output_name: str) -> Path:
        settings = _comfy_settings(job)
        run_id = job["run_id"]
        response = self.request_json(
            "POST", "/prompt", {"prompt": graph, "client_id": f"forge-media-{run_id}"}
        )
        prompt_id = response.get("prompt_id") if isinstance(response, dict) else None
        if not isinstance(prompt_id, str) or not prompt_id:
            raise MediaJobError(f"ComfyUI did not return a prompt_id: {response!r}")
        deadline = time.monotonic() + settings["job_timeout_seconds"]
        history: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            response = self.request_json("GET", f"/history/{prompt_id}")
            if isinstance(response, dict) and prompt_id in response:
                history = response[prompt_id]
                break
            time.sleep(1)
        if history is None:
            raise MediaJobError(
                f"ComfyUI job {prompt_id} timed out after {settings['job_timeout_seconds']}s."
            )
        status = history.get("status", {})
        if status.get("status_str") == "error" or status.get("completed") is False:
            raise MediaJobError(f"ComfyUI job {prompt_id} failed: {status!r}")
        files = _history_files(history, require_directory(settings["output_dir"], "comfyui.output_dir"))
        candidates = [path for path in files if path.suffix.lower() == suffix.lower()]
        if len(candidates) != 1:
            names = ", ".join(str(path) for path in candidates) or "none"
            raise MediaJobError(
                f"ComfyUI job {prompt_id} produced {len(candidates)} {suffix} outputs; found: {names}."
            )
        source = candidates[0]
        destination = Path(job["run_dir"]) / "output" / output_name
        if destination.exists():
            raise MediaJobError(f"Refusing to overwrite existing media output: {destination}")
        shutil.copy2(source, destination)
        return destination


@contextlib.contextmanager
def start_owned_comfyui(job: dict[str, Any]) -> Iterator[ComfyClient]:
    settings = _comfy_settings(job)
    require_cuda_environment(job)
    root = require_directory(settings["root"], "comfyui.root")
    python = require_file(settings["python"], "comfyui.python")
    input_dir = require_directory(settings["input_dir"], "comfyui.input_dir")
    output_dir = require_directory(settings["output_dir"], "comfyui.output_dir")
    temp_dir = require_directory(settings["temp_dir"], "comfyui.temp_dir")
    user_dir = require_directory(settings["user_dir"], "comfyui.user_dir")
    if input_dir.resolve() != (root / "input").resolve():
        raise MediaJobError("comfyui.input_dir must be the configured ComfyUI root's own input folder.")
    if output_dir.resolve() != (root / "output").resolve():
        raise MediaJobError("comfyui.output_dir must be the configured ComfyUI root's own output folder.")
    run_dir = Path(job["run_dir"]).resolve()
    for name, directory in (("temp_dir", temp_dir), ("user_dir", user_dir)):
        try:
            directory.resolve().relative_to(run_dir)
        except ValueError as exc:
            raise MediaJobError(f"comfyui.{name} must be inside the media run folder.") from exc
    if not (root / "main.py").is_file():
        raise MediaJobError(f"ComfyUI main.py was not found under configured root: {root}")
    if not _port_is_available(settings["host"], settings["port"]):
        raise MediaJobError(
            f"ComfyUI port {settings['port']} is already in use at {settings['host']}; "
            "refusing to connect to or stop a process this job did not start."
        )
    command = [
        str(python),
        str(root / "main.py"),
        "--listen",
        settings["host"],
        "--port",
        str(settings["port"]),
        "--temp-directory",
        str(temp_dir),
        "--user-directory",
        str(user_dir),
        *settings["startup_args"],
    ]
    log_path = Path(job["run_dir"]) / "logs" / "comfyui.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    environment = local_process_environment(job)
    client = ComfyClient(settings["host"], settings["port"], 20)
    with log_path.open("ab") as log:
        try:
            process = subprocess.Popen(
                command,
                cwd=str(root),
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            )
        except OSError as exc:
            raise MediaJobError(f"Could not start configured ComfyUI: {exc}") from exc
        job_handle = None
        try:
            job_handle = _create_kill_on_close_job(process)
            deadline = time.monotonic() + settings["startup_timeout_seconds"]
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise MediaJobError(
                        f"Owned ComfyUI exited with status {process.returncode}; log: {log_path}\n"
                        f"{read_log_tail(log_path)}"
                    )
                try:
                    client.request_json("GET", "/system_stats")
                    break
                except MediaJobError:
                    time.sleep(1)
            else:
                raise MediaJobError(
                    f"Owned ComfyUI did not answer on port {settings['port']} within "
                    f"{settings['startup_timeout_seconds']}s; log: {log_path}\n{read_log_tail(log_path)}"
                )
            yield client
        finally:
            _close_job(job_handle)
            if job_handle is None and process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    # These paths are deliberately required, even when a graph itself never reads input.
    _ = input_dir, output_dir, user_dir


def stage_input(job: dict[str, Any], source_value: Any, name: str) -> str:
    settings = _comfy_settings(job)
    input_dir = require_directory(settings["input_dir"], "comfyui.input_dir")
    source = require_file(source_value, name)
    destination = input_dir / f"forge_{job['run_id']}_{source.name}"
    if destination.exists():
        raise MediaJobError(f"Refusing to overwrite existing ComfyUI input: {destination}")
    shutil.copy2(source, destination)
    return destination.name


def remove_staged_input(job: dict[str, Any], name: str) -> None:
    settings = _comfy_settings(job)
    input_dir = require_directory(settings["input_dir"], "comfyui.input_dir")
    prefix = f"forge_{job['run_id']}_"
    if not name.startswith(prefix) or Path(name).name != name:
        raise MediaJobError("Refusing to remove a ComfyUI input not created for this run.")
    destination = input_dir / name
    if destination.exists():
        try:
            destination.resolve().relative_to(input_dir.resolve())
        except ValueError as exc:
            raise MediaJobError("Refusing to remove an input outside the ComfyUI input folder.") from exc
        destination.unlink()


def _history_files(history: dict[str, Any], output_root: Path) -> list[Path]:
    outputs = history.get("outputs")
    if not isinstance(outputs, dict):
        raise MediaJobError("ComfyUI history record has no outputs object.")
    found: list[Path] = []
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        for key in ("videos", "audio", "gifs", "images"):
            entries = node_output.get(key, [])
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict) or not isinstance(entry.get("filename"), str):
                    continue
                if entry.get("type", "output") != "output":
                    continue
                candidate = (output_root / entry.get("subfolder", "") / entry["filename"]).resolve()
                try:
                    candidate.relative_to(output_root.resolve())
                except ValueError as exc:
                    raise MediaJobError("ComfyUI history returned an output path outside output_dir.") from exc
                if candidate.is_file():
                    found.append(candidate)
    return found
