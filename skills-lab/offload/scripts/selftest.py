#!/usr/bin/env python3
"""Exercise the guarded copy/verify/purge flow in an OS temporary directory."""

import sys

sys.dont_write_bytecode = True

import os
import importlib.util
import shutil
import subprocess
import tempfile
from pathlib import Path


EXIT_PURGE_REFUSED = 5
EXIT_BAD_ARGUMENTS = 2


def run(script: Path, *args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        [sys.executable, "-B", str(script), *args],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )


def require(condition: bool, message: str, result: subprocess.CompletedProcess[str] | None = None) -> None:
    if not condition:
        details = ""
        if result is not None:
            details = f"\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        raise AssertionError(message + details)


def main() -> int:
    if os.name != "nt":
        print("SKIP offload self-test requires Windows")
        return 0
    if not shutil.which("robocopy"):
        print("SKIP offload self-test: robocopy is missing")
        return 0

    script = Path(__file__).resolve().with_name("offload.py")
    spec = importlib.util.spec_from_file_location("offload_under_test", script)
    require(spec is not None and spec.loader is not None, "could not load offload module")
    offload = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(offload)
    with tempfile.TemporaryDirectory(prefix="offload-selftest-") as temp:
        root = Path(temp)
        source = root / "source"
        source.mkdir()
        (source / "nested").mkdir()
        (source / "one.txt").write_text("first file\n", encoding="utf-8")
        (source / "nested" / "two.bin").write_bytes(b"second file\x00\x01")
        dest_root = root / "destination"
        logs = root / "logs"
        dest = dest_root / source.drive.rstrip(":\\/") / source.relative_to(source.anchor)

        copied = run(script, "--copy", "--dest-root", str(dest_root), "--log-dir", str(logs), str(source))
        require(copied.returncode == 0, "copy step failed", copied)
        print("STEP copy: ok")

        no_confirmation = run(
            script, "--purge", "--dest-root", str(dest_root), "--log-dir", str(logs), str(source),
        )
        require(no_confirmation.returncode == EXIT_BAD_ARGUMENTS, "purge without confirmation was accepted", no_confirmation)
        require((source / "one.txt").is_file() and (source / "nested" / "two.bin").is_file(), "unconfirmed purge changed source", no_confirmation)
        print("STEP purge-needs-confirmation: ok")

        verified = run(script, "--verify", "--dest-root", str(dest_root), str(source))
        require(verified.returncode == 0, "initial verify step failed", verified)
        require("missing=0 size-mismatch=0 extra=0" in verified.stdout, "initial verify counts were not clean", verified)
        print("STEP verify-clean: ok")

        late_file = source / "after-copy.txt"
        late_file.write_text("created after copy\n", encoding="utf-8")
        missing = run(
            script,
            "--purge", "--yes-purge", "--dest-root", str(dest_root), "--log-dir", str(logs), str(source),
        )
        require(missing.returncode == EXIT_PURGE_REFUSED, "purge did not refuse an un-copied file", missing)
        require("MISSING" in missing.stdout and "after-copy.txt" in missing.stdout, "verification did not identify the late file", missing)
        require(late_file.is_file(), "refused purge changed source", missing)
        late_file.unlink()
        print("STEP late-file-purge-refused: ok")

        target = dest / "one.txt"
        target.write_bytes(target.read_bytes() + b"changed")
        refused = run(
            script,
            "--purge", "--yes-purge", "--dest-root", str(dest_root), "--log-dir", str(logs), str(source),
        )
        require(refused.returncode == EXIT_PURGE_REFUSED, "purge did not refuse a size mismatch", refused)
        require("PURGE REFUSED" in refused.stderr, "refused purge did not explain why", refused)
        require((source / "one.txt").exists(), "source changed after refused purge", refused)
        print("STEP mismatch-purge-refused: ok")

        target.write_bytes((source / "one.txt").read_bytes())
        restored = run(
            script,
            "--purge", "--yes-purge", "--dest-root", str(dest_root), "--log-dir", str(logs), str(source),
        )
        require(restored.returncode == 0, "clean same-call verify and purge failed", restored)
        require("missing=0 size-mismatch=0 extra=0" in restored.stdout, "purge call lacked a clean verify", restored)
        require(source.is_dir() and not any(source.iterdir()), "successful purge did not leave an empty source folder", restored)
        print("STEP restore-verify-purge: ok")

        verified_file = source / "verified.txt"
        unverified_file = source / "unverified.txt"
        verified_file.write_text("verified", encoding="utf-8")
        unverified_file.write_text("keep", encoding="utf-8")
        function_log = logs / "purge-function.log"
        kept = offload.purge_files(source, {"verified.txt": ("verified.txt", len("verified"))}, function_log)
        require(kept == 1, "function purge did not count the unverified file as kept")
        require(not verified_file.exists() and unverified_file.is_file(), "function purge deleted the wrong files")
        require("DELETED verified.txt" in function_log.read_text(encoding="utf-8"), "function purge log omitted deletion")
        require("KEPT not-verified unverified.txt" in function_log.read_text(encoding="utf-8"), "function purge log omitted kept file")
        print("STEP purge-keeps-unverified: ok")

        outside = root / "outside"
        outside.mkdir()
        outside_file = outside / "must-survive.txt"
        outside_file.write_text("outside", encoding="utf-8")
        junction = source / "link"
        linked = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(junction), str(outside)],
            check=False, capture_output=True, text=True,
        )
        require(linked.returncode == 0 and junction.exists(), "could not create junction", linked)
        refused_reparse = run(
            script,
            "--purge", "--yes-purge", "--dest-root", str(dest_root), "--log-dir", str(logs), str(source),
        )
        require(refused_reparse.returncode == EXIT_PURGE_REFUSED, "purge did not refuse a junction", refused_reparse)
        require("PURGE REFUSED" in refused_reparse.stderr and ":: link" in refused_reparse.stderr, "junction refusal did not name reparse point", refused_reparse)
        require(outside_file.is_file(), "junction target file was changed", refused_reparse)
        os.rmdir(junction)
        print("STEP junction-purge-refused: ok")

    print("PASS offload self-test")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
