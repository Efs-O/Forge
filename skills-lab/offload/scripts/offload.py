#!/usr/bin/env python3
"""Copy, verify, and optionally purge folders with guarded robocopy calls."""

import sys

sys.dont_write_bytecode = True

import argparse
import math
import os
import shutil
import stat
import subprocess
from datetime import datetime
from pathlib import Path


EXIT_BAD_ARGUMENTS = 2
EXIT_UNAVAILABLE = 3
EXIT_COPY_VERIFY_FAILED = 4
EXIT_PURGE_REFUSED = 5
GIB = 1024 ** 3

ROBOCOPY_SUCCESS = {
    0: "no files copied; no differences found",
    1: "files copied successfully",
    2: "extra files or directories detected",
    3: "files copied and extras detected",
    4: "mismatches detected",
    5: "files copied and mismatches detected",
    6: "extras and mismatches detected",
    7: "files copied, extras, and mismatches detected",
}


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(EXIT_BAD_ARGUMENTS, f"{self.prog}: error: {message}\n")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = ArgumentParser(
        description="Copy folders, verify relative paths and sizes, and purge only after same-call verification."
    )
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry", action="store_true", help="inventory sources and destination free space (default)")
    modes.add_argument("--copy", action="store_true", help="copy sources with robocopy")
    modes.add_argument("--verify", action="store_true", help="compare every source and destination file")
    modes.add_argument("--purge", action="store_true", help="verify now, then empty sources if verification is clean")
    parser.add_argument("--yes-purge", action="store_true", help="confirm the destructive --purge operation")
    parser.add_argument("--dest-root", required=True, metavar="DIR", help="root under which source paths are mirrored")
    parser.add_argument("--headroom-gib", type=float, default=20, help="free-space headroom for --dry (default: 20)")
    parser.add_argument("--log-dir", metavar="DIR", help="required for --copy and --purge; robocopy logs go here")
    parser.add_argument("sources", nargs="+", metavar="SOURCE", help="one or more source folders")
    args = parser.parse_args(argv)
    if args.yes_purge and not args.purge:
        parser.error("--yes-purge is only valid with --purge")
    if args.purge and not args.yes_purge:
        parser.error("--purge requires --yes-purge")
    if (args.copy or args.purge) and not args.log_dir:
        parser.error("--copy and --purge require --log-dir")
    if not math.isfinite(args.headroom_gib) or args.headroom_gib < 0:
        parser.error("--headroom-gib must be a finite nonnegative number")
    return args


def robocopy_path(path: Path) -> str:
    """Return an absolute path without a trailing separator (robocopy-safe)."""
    value = os.path.abspath(os.fspath(path))
    drive, tail = os.path.splitdrive(value)
    if tail in (os.sep, os.altsep):
        # A volume/share root cannot be stripped to a path without a final
        # separator; the trailing dot preserves the root while avoiding the
        # quoted-argument parsing hazard in robocopy.
        value = value + "."
    else:
        value = value.rstrip("\\/")
    return value


def destination_for(source: Path, dest_root: Path) -> Path:
    if len(source.drive) != 2 or source.drive[1] != ":" or not source.drive[0].isalpha():
        raise ValueError(f"source must be on a drive with a letter: {source}")
    drive = source.drive[0]
    relative = source.relative_to(Path(source.anchor))
    return dest_root / drive / relative


def _is_reparse_point(path: Path, metadata: os.stat_result) -> bool:
    attributes = getattr(metadata, "st_file_attributes", 0)
    return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT) or stat.S_ISLNK(metadata.st_mode)


def tree_inventory(
    root: Path,
) -> tuple[dict[str, tuple[str, int]], list[str], list[Path]]:
    files: dict[str, tuple[str, int]] = {}
    reparses: list[str] = []
    directories: list[Path] = []

    def visit(directory: Path) -> None:
        try:
            entries = list(os.scandir(directory))
        except OSError as exc:
            raise OSError(f"cannot inspect {directory}: {exc}") from exc
        for entry in entries:
            path = Path(entry.path)
            relative = path.relative_to(root).as_posix()
            try:
                metadata = path.lstat()
            except OSError as exc:
                raise OSError(f"cannot inspect {path}: {exc}") from exc
            if _is_reparse_point(path, metadata):
                reparses.append(relative)
            elif stat.S_ISDIR(metadata.st_mode):
                directories.append(path)
                visit(path)
            else:
                files[relative.casefold()] = (relative, metadata.st_size)

    visit(root)
    return files, reparses, directories


def file_inventory(root: Path, reparse_points: list[str] | None = None) -> dict[str, tuple[str, int]]:
    files, reparses, _ = tree_inventory(root)
    if reparse_points is not None:
        reparse_points.extend(reparses)
    return files


def verify_pair(
    source: Path,
    destination: Path,
    source_files: dict[str, tuple[str, int]] | None = None,
) -> tuple[int, int, int]:
    source_reparses: list[str] = []
    destination_reparses: list[str] = []
    if source_files is None:
        source_files = file_inventory(source, source_reparses)
    else:
        file_inventory(source, source_reparses)
    destination_files = file_inventory(destination, destination_reparses) if destination.is_dir() else {}
    for relative in source_reparses:
        print(f"REPARSE {source} :: {relative}")
    for relative in destination_reparses:
        print(f"REPARSE {destination} :: {relative}")
    missing = mismatched = extra = 0
    for key, (relative, size) in sorted(source_files.items()):
        other = destination_files.get(key)
        if other is None:
            missing += 1
            print(f"MISSING {source} :: {relative}")
        elif other[1] != size:
            mismatched += 1
            print(f"SIZE-MISMATCH {source} :: {relative} source={size} destination={other[1]}")
        else:
            print(f"OK {source} :: {relative} ({size} bytes)")
    for key, (relative, size) in sorted(destination_files.items()):
        if key not in source_files:
            extra += 1
            print(f"EXTRA {source} :: {relative} ({size} bytes)")
    print(f"VERIFY {source}: missing={missing} size-mismatch={mismatched} extra={extra}")
    return missing, mismatched, extra


def run_robocopy(args: list[str]) -> int:
    try:
        result = subprocess.run(args, check=False)
    except OSError as exc:
        print(f"robocopy could not run: {exc}", file=sys.stderr)
        return EXIT_COPY_VERIFY_FAILED
    code = result.returncode
    if 0 <= code <= 7:
        print(f"robocopy exit {code}: {ROBOCOPY_SUCCESS[code]}")
        return 0
    print(f"robocopy exit {code}: failure (8 or greater)", file=sys.stderr)
    return EXIT_COPY_VERIFY_FAILED


def destination_space(path: Path) -> int:
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    return shutil.disk_usage(probe).free


def validate_sources(source_args: list[str]) -> list[Path]:
    sources: list[Path] = []
    for raw in source_args:
        source = Path(os.path.abspath(raw))
        if len(source.drive) != 2 or source.drive[1] != ":" or not source.drive[0].isalpha():
            raise ValueError(f"source must be on a drive with a letter: {source}")
        if not source.is_dir():
            raise OSError(f"source folder does not exist or is not a directory: {source}")
        if source == Path(source.anchor):
            raise ValueError(f"refusing to use a volume root as a source folder: {source}")
        sources.append(source)
    for index, source in enumerate(sources):
        for other in sources[index + 1:]:
            if source == other or source in other.parents or other in source.parents:
                raise ValueError(f"source folders overlap: {source} and {other}")
    return sources


def reserve_log(log_dir: Path, kind: str, index: int) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = f"{kind}-{stamp}-{index:02d}"
    suffix = 0
    while True:
        tail = f"-{suffix}" if suffix else ""
        candidate = log_dir / f"{base}{tail}.log"
        try:
            candidate.open("x", encoding="utf-8").close()
            return candidate
        except FileExistsError:
            suffix += 1


def purge_files(source: Path, inventory: dict[str, tuple[str, int]], log_path: Path) -> int:
    _, reparses, directories = tree_inventory(source)
    if reparses:
        raise ValueError("source contains reparse points: " + ", ".join(reparses[:5]))

    kept = 0
    with log_path.open("a", encoding="utf-8", newline="\n") as log:
        for key, (relative, size) in sorted(inventory.items()):
            path = source / Path(relative)
            try:
                metadata = path.lstat()
            except FileNotFoundError:
                continue
            if _is_reparse_point(path, metadata) or metadata.st_size != size:
                message = f"KEPT changed-since-verify {relative}"
                print(message)
                log.write(message + "\n")
                kept += 1
                continue
            path.unlink()
            message = f"DELETED {relative}"
            print(message)
            log.write(message + "\n")

        verified_keys = set(inventory)
        current, reparses, _ = tree_inventory(source)
        if reparses:
            raise ValueError("source contains reparse points: " + ", ".join(reparses[:5]))
        for key, (relative, _) in sorted(current.items()):
            if key not in verified_keys:
                message = f"KEPT not-verified {relative}"
                print(message)
                log.write(message + "\n")
                kept += 1

        for directory in sorted(directories, key=lambda item: len(item.parts), reverse=True):
            try:
                directory.rmdir()
                relative = directory.relative_to(source).as_posix()
                message = f"DELETED DIRECTORY {relative}"
                print(message)
                log.write(message + "\n")
            except OSError:
                pass
    return kept


def paths_overlap(left: Path, right: Path) -> bool:
    left = left.resolve()
    right = right.resolve()
    return left == right or left in right.parents or right in left.parents


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if os.name != "nt":
        print("offload requires Windows and robocopy", file=sys.stderr)
        return EXIT_UNAVAILABLE
    robocopy = shutil.which("robocopy")
    if not robocopy:
        print("robocopy was not found on PATH", file=sys.stderr)
        return EXIT_UNAVAILABLE
    try:
        sources = validate_sources(args.sources)
        dest_root = Path(os.path.abspath(args.dest_root))
        pairs = [(source, destination_for(source, dest_root)) for source in sources]
        log_dir = Path(os.path.abspath(args.log_dir)) if args.log_dir else None
        for source, destination in pairs:
            if paths_overlap(source, destination):
                raise ValueError(f"source and destination overlap: {source} and {destination}")
            if log_dir and (paths_overlap(source, log_dir) or paths_overlap(destination, log_dir)):
                raise ValueError(f"log directory must be outside source and destination trees: {log_dir}")
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_BAD_ARGUMENTS

    if args.dry or not (args.copy or args.verify or args.purge):
        try:
            dry_inventory: list[dict[str, tuple[str, int]]] = []
            for source, destination in pairs:
                reparses: list[str] = []
                inventory = file_inventory(source, reparses)
                dry_inventory.append(inventory)
                total_bytes = sum(size for _, size in inventory.values())
                free = destination_space(dest_root)
                needed = total_bytes + int(args.headroom_gib * GIB)
                print(
                    f"DRY {source}: files={len(inventory)} bytes={total_bytes}; "
                    f"destination={destination}; free={free} bytes; "
                    f"required={needed} bytes (headroom={args.headroom_gib:g} GiB); "
                    f"space={'OK' if free >= needed else 'LOW'}"
                )
            total_bytes = sum(sum(size for _, size in inventory.values()) for inventory in dry_inventory)
            free = destination_space(dest_root)
            needed = total_bytes + int(args.headroom_gib * GIB)
            print(
                f"DRY total: files={sum(len(inventory) for inventory in dry_inventory)} "
                f"bytes={total_bytes}; free={free} bytes; required={needed} bytes "
                f"(headroom={args.headroom_gib:g} GiB); space={'OK' if free >= needed else 'LOW'}"
            )
        except OSError as exc:
            print(str(exc), file=sys.stderr)
            return EXIT_COPY_VERIFY_FAILED
        return 0

    if args.copy:
        try:
            assert log_dir is not None
            log_dir.mkdir(parents=True, exist_ok=True)
            for index, (source, destination) in enumerate(pairs, start=1):
                destination.parent.mkdir(parents=True, exist_ok=True)
                log = reserve_log(log_dir, "copy", index)
                command = [
                    robocopy,
                    robocopy_path(source),
                    robocopy_path(destination),
                    "/E", "/Z", "/NP", "/R:3", "/W:3", "/DCOPY:T", "/SL",
                    f"/LOG+:{robocopy_path(log)}",
                    "/XJ",
                ]
                print(f"COPY {source} -> {destination}; log={log}")
                if run_robocopy(command):
                    return EXIT_COPY_VERIFY_FAILED
        except OSError as exc:
            print(f"copy setup failed: {exc}", file=sys.stderr)
            return EXIT_COPY_VERIFY_FAILED
        return 0

    reparse_sources: list[tuple[Path, list[str]]] = []
    try:
        for source, _ in pairs:
            reparses: list[str] = []
            file_inventory(source, reparses)
            if reparses:
                reparse_sources.append((source, reparses))
    except OSError as exc:
        print(f"verification failed: {exc}", file=sys.stderr)
        return EXIT_PURGE_REFUSED if args.purge else EXIT_COPY_VERIFY_FAILED
    if args.purge and reparse_sources:
        first = [f"{source} :: {relative}" for source, paths in reparse_sources for relative in paths[:5]]
        print(
            "PURGE REFUSED: source contains reparse points (symlinks or junctions): "
            + "; ".join(first[:5]),
            file=sys.stderr,
        )
        return EXIT_PURGE_REFUSED

    source_inventories: list[dict[str, tuple[str, int]]] = []
    try:
        verification = []
        for source, destination in pairs:
            source_reparses: list[str] = []
            source_inventory = file_inventory(source, source_reparses)
            source_inventories.append(source_inventory)
            verification.append(verify_pair(source, destination, source_inventory))
    except OSError as exc:
        print(f"verification failed: {exc}", file=sys.stderr)
        if args.purge:
            print("PURGE REFUSED: verification could not complete in this call", file=sys.stderr)
            return EXIT_PURGE_REFUSED
        return EXIT_COPY_VERIFY_FAILED

    if not args.purge:
        return 0 if all(missing == 0 and mismatch == 0 for missing, mismatch, _ in verification) else EXIT_COPY_VERIFY_FAILED

    failures = [
        (source, counts) for (source, _), counts in zip(pairs, verification)
        if counts[0] != 0 or counts[1] != 0
    ]
    if failures:
        print(
            "PURGE REFUSED: same-call verification found missing files or size mismatches: "
            + "; ".join(f"{source} (missing={counts[0]}, size-mismatch={counts[1]})" for source, counts in failures),
            file=sys.stderr,
        )
        return EXIT_PURGE_REFUSED

    try:
        assert log_dir is not None
        log_dir.mkdir(parents=True, exist_ok=True)
        kept_total = 0
        for index, ((source, _), inventory) in enumerate(zip(pairs, source_inventories), start=1):
            log = reserve_log(log_dir, "purge", index)
            print(f"PURGE {source}: clean same-call verification; log={log}")
            kept_total += purge_files(source, inventory, log)
        if kept_total:
            print(f"PURGE PARTIAL kept={kept_total}")
        return 0
    except ValueError as exc:
        print(f"PURGE REFUSED: {exc}", file=sys.stderr)
        return EXIT_PURGE_REFUSED
    except OSError as exc:
        print(f"purge failed: {exc}", file=sys.stderr)
        return EXIT_COPY_VERIFY_FAILED
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
