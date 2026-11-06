#!/usr/bin/env python3
"""Measure still-image colour, dark areas, differences, and PNG text chunks."""

import sys
sys.dont_write_bytecode = True

import argparse
import json
import math
import re
import struct
import zlib
from pathlib import Path

from mediakit_dependencies import require


def _rgb(text: str) -> tuple[int, int, int]:
    try:
        parts = [int(value.strip()) for value in text.split(",")]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("RGB must be three integers in 0..255") from exc
    if len(parts) != 3 or any(value < 0 or value > 255 for value in parts):
        raise argparse.ArgumentTypeError("RGB must be three integers in 0..255")
    return tuple(parts)


def _pair(text: str) -> tuple[float, float]:
    try:
        values = tuple(float(value.strip()) for value in text.split(","))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("expected two comma-separated numbers") from exc
    if len(values) != 2 or not all(math.isfinite(value) and value >= 0 for value in values):
        raise argparse.ArgumentTypeError("expected two non-negative finite numbers")
    if values[0] > values[1]:
        raise argparse.ArgumentTypeError("first threshold must not exceed second")
    return values


def _box_image(path: Path, box_text: str):
    from PIL import Image
    from mediakit import parse_box

    with Image.open(path) as source:
        image = source.convert("RGB")
    return image, parse_box(box_text, image.width, image.height)


def _crop(image, box):
    return image.crop(box)


def _region_mean(image, box):
    """Mean RGB of the box's inset middle half sampled on a fixed 48x48 grid."""
    from PIL import Image
    import numpy as np

    x0, y0, x1, y1 = box
    inset_x, inset_y = (x1 - x0) / 4, (y1 - y0) / 4
    middle = image.crop((round(x0 + inset_x), round(y0 + inset_y),
                         round(x1 - inset_x), round(y1 - inset_y)))
    sampled = np.asarray(middle.resize((48, 48), Image.Resampling.LANCZOS), dtype=np.float64)
    return tuple(float(value) for value in sampled.mean(axis=(0, 1)))


def _png_text_chunks(path: Path):
    """Read all PNG tEXt, zTXt, and iTXt chunks, preserving duplicate keys."""
    signature = b"\x89PNG\r\n\x1a\n"
    with path.open("rb") as stream:
        if stream.read(8) != signature:
            raise ValueError(f"not a PNG file: {path}")
        chunks = []
        while True:
            header = stream.read(8)
            if len(header) != 8:
                raise ValueError(f"truncated PNG chunk header: {path}")
            length, kind = struct.unpack(">I4s", header)
            data = stream.read(length)
            crc = stream.read(4)
            if len(data) != length or len(crc) != 4:
                raise ValueError(f"truncated PNG chunk: {path}")
            key = text = None
            text_length = 0
            if kind == b"tEXt":
                key_bytes, separator, payload = data.partition(b"\0")
                if separator:
                    key, text = key_bytes.decode("latin-1"), payload.decode("latin-1")
                    text_length = len(payload)
            elif kind == b"zTXt":
                key_bytes, separator, rest = data.partition(b"\0")
                if separator and len(rest) >= 2 and rest[0] == 0:
                    try:
                        payload = zlib.decompress(rest[1:])
                    except zlib.error as exc:
                        raise ValueError(f"corrupt compressed text chunk in {path}") from exc
                    key, text = key_bytes.decode("latin-1"), payload.decode("latin-1")
                    text_length = len(payload)
            elif kind == b"iTXt":
                key_bytes, separator, rest = data.partition(b"\0")
                if separator and len(rest) >= 2:
                    compressed, method = rest[:2]
                    language, separator, rest = rest[2:].partition(b"\0")
                    translated, separator2, payload = rest.partition(b"\0")
                    if separator and separator2 and method == 0:
                        if compressed:
                            try:
                                payload = zlib.decompress(payload)
                            except zlib.error as exc:
                                raise ValueError(f"corrupt compressed text chunk in {path}") from exc
                        key = key_bytes.decode("latin-1")
                        text = payload.decode("utf-8", errors="replace")
                        text_length = len(payload)
            if key is not None and text is not None:
                chunks.append({"key": key, "length": text_length, "text": text})
            if kind == b"IEND":
                return chunks


def _measure(args):
    import numpy as np
    from mediakit import mad, parse_box
    from PIL import Image

    if args.subcommand == "color":
        image, box = _box_image(args.image, args.box)
        measured = _region_mean(image, box)
        if args.reference:
            reference, ref_box = _box_image(args.reference, args.box)
            target = _region_mean(reference, ref_box)
            target_source = str(args.reference)
        else:
            target = args.target
            target_source = "explicit target"
        distance = math.dist(measured, target)
        near, far = args.tol
        verdict = "near" if distance <= near else ("far" if distance >= far else "between")
        return {
            "image": str(args.image), "box": list(box), "mean_rgb": list(measured),
            "target_rgb": list(target), "target_source": target_source,
            "distance": distance, "tolerance": {"near": near, "far": far},
            "verdict": verdict,
        }

    if args.subcommand == "black":
        images = [args.image, *(args.compare or [])]
        results = []
        ref_share = None
        for index, path in enumerate(images):
            image, box = _box_image(path, args.box)
            rgb = np.asarray(_crop(image, box), dtype=np.uint8)
            share = float(np.mean(np.max(rgb, axis=2) < args.black_max) * 100)
            if index == 0:
                ref_share = share
            results.append({"image": str(path), "black_percent": share})
        worst_delta = max((entry["black_percent"] - ref_share for entry in results[1:]), default=0.0)
        return {
            "box": list(box), "black_max": args.black_max, "delta_threshold_pp": args.delta,
            "images": results, "reference": str(args.image),
            "worst_compare_delta_pp": worst_delta,
            "verdict": "exceeds" if worst_delta > args.delta else "within",
        }

    if args.subcommand == "diff":
        first = Image.open(args.first).convert("RGB")
        second = Image.open(args.second).convert("RGB")
        if args.box:
            box = parse_box(args.box, first.width, first.height)
            second_box = parse_box(args.box, second.width, second.height)
            first, second = _crop(first, box), _crop(second, second_box)
        else:
            box = None
        return {"first": str(args.first), "second": str(args.second),
                "box": list(box) if box else None, "mad": mad(first, second)}

    if args.meta_command == "show":
        chunks = _png_text_chunks(args.image)
        if args.chunk:
            chunks = [item for item in chunks if item["key"] == args.chunk]
        return {"image": str(args.image), "chunks": chunks}

    if args.meta_command == "dump":
        args.out.mkdir(parents=True, exist_ok=True)
        written = []
        for path in sorted(args.folder.glob("*.png")):
            chunks = _png_text_chunks(path)
            for chunk_index, chunk in enumerate(chunks):
                key, text = chunk["key"], chunk["text"]
                if args.chunk and key != args.chunk:
                    continue
                safe_key = re.sub(r"[^A-Za-z0-9._-]+", "_", key).strip("._") or "chunk"
                suffix = f".{chunk_index + 1}" if sum(item["key"] == key for item in chunks) > 1 else ""
                target = args.out / f"{path.stem}.{safe_key}{suffix}.txt"
                try:
                    with target.open("x", encoding="utf-8", newline="\n") as stream:
                        stream.write(text)
                except FileExistsError:
                    raise ValueError(f"refusing to overwrite existing file: {target}")
                written.append({"path": str(target), "key": key, "length": len(text.encode("utf-8"))})
        return {"folder": str(args.folder), "files": written}
    raise ValueError("unknown command")


def _parser():
    parser = argparse.ArgumentParser(description="Measure still-image colour, dark areas, differences, and PNG text chunks.")
    commands = parser.add_subparsers(dest="subcommand", required=True)
    color = commands.add_parser("color", help="compare mean RGB in the inset middle of a box")
    color.add_argument("image", type=Path)
    color.add_argument("--box", required=True)
    target = color.add_mutually_exclusive_group(required=True)
    target.add_argument("--target", type=_rgb)
    target.add_argument("--reference", type=Path)
    color.add_argument("--tol", type=_pair, default=(40.0, 70.0), metavar="NEAR,FAR")
    color.add_argument("--json", action="store_true")
    black = commands.add_parser("black", help="measure the share below the near-black threshold")
    black.add_argument("image", type=Path)
    black.add_argument("--compare", type=Path, action="append", default=[])
    black.add_argument("--box", required=True)
    black.add_argument("--black-max", type=int, default=60)
    black.add_argument("--delta", type=float, default=1.0)
    black.add_argument("--json", action="store_true")
    diff = commands.add_parser("diff", help="measure grayscale mean absolute difference")
    diff.add_argument("first", type=Path)
    diff.add_argument("second", type=Path)
    diff.add_argument("--box")
    diff.add_argument("--json", action="store_true")
    meta = commands.add_parser("meta", help="show or safely dump PNG text chunks")
    meta_commands = meta.add_subparsers(dest="meta_command", required=True)
    show = meta_commands.add_parser("show")
    show.add_argument("image", type=Path)
    show.add_argument("--chunk")
    show.add_argument("--json", action="store_true")
    dump = meta_commands.add_parser("dump")
    dump.add_argument("folder", type=Path)
    dump.add_argument("--out", type=Path, required=True)
    dump.add_argument("--chunk")
    dump.add_argument("--json", action="store_true")
    return parser


def main(argv=None):
    require()
    parser = _parser()
    try:
        args = parser.parse_args(argv)
        if args.subcommand == "black" and not 0 <= args.black_max <= 255:
            parser.error("--black-max must be in 0..255")
        if args.subcommand == "black" and (not math.isfinite(args.delta) or args.delta < 0):
            parser.error("--delta must be non-negative and finite")
        result = _measure(args)
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        elif args.subcommand == "color":
            print(f"mean RGB: {tuple(round(value, 3) for value in result['mean_rgb'])}")
            print(f"target RGB: {tuple(round(value, 3) for value in result['target_rgb'])} ({result['target_source']})")
            print(f"distance: {result['distance']:.3f}; tol near <= {args.tol[0]:g}, far >= {args.tol[1]:g}; {result['verdict']}")
        elif args.subcommand == "black":
            for entry in result["images"]:
                print(f"{entry['image']}: {entry['black_percent']:.3f}% below max-channel {args.black_max}")
            print(f"worst compare delta: {result['worst_compare_delta_pp']:+.3f} pp; threshold {args.delta:g} pp; {result['verdict']}")
        elif args.subcommand == "diff":
            print(f"grayscale MAD: {result['mad']:.6f}")
        elif args.meta_command == "show":
            for entry in result["chunks"]:
                print(f"{entry['key']} ({entry['length']} bytes): {entry['text']}")
        else:
            for entry in result["files"]:
                print(f"{entry['path']}: {entry['key']} ({entry['length']} bytes)")
        return 0
    except SystemExit as exc:
        return int(exc.code)
    except (OSError, ValueError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
