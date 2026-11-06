#!/usr/bin/env python3
"""Apply image repairs and verified audio/video concatenation."""

import sys
sys.dont_write_bytecode = True

import argparse
import json
import math
import os
import subprocess
import tempfile
from pathlib import Path

from mediakit_dependencies import require


def _run(command):
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        raise RuntimeError(detail.strip()) from exc


def _scan_axis0(luma, pixels, box, mask, lum, max_run, search):
    """Repair dark runs in each row of an oriented image and its local mask."""
    import numpy as np

    x0, y0, x1, y1 = box
    seen = kept = painted = 0
    for row in range(y0, y1):
        dark = luma[row] < lum
        edges = np.diff(np.concatenate(([False], dark, [False])).astype(np.int8))
        starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
        for start, end in zip(starts, ends):
            if start < x0 or end > x1:
                continue
            seen += 1
            width = int(end - start)
            if width > max_run or start == 0 or end == luma.shape[1]:
                continue
            left = max(0, int(start) - search)
            right = min(luma.shape[1], int(end) + search)
            candidates_left = np.flatnonzero(~dark[left:start]) + left
            candidates_right = np.flatnonzero(~dark[end:right]) + end
            if not len(candidates_left) or not len(candidates_right):
                continue
            kept += 1
            left_x, right_x = int(candidates_left[-1]), int(candidates_right[0])
            left_rgb = pixels[row, left_x].astype(np.float64)
            right_rgb = pixels[row, right_x].astype(np.float64)
            ramp = np.linspace(left_rgb, right_rgb, right_x - left_x + 1)[1:-1]
            pixels[row, start:end] = np.clip(np.rint(ramp), 0, 255).astype(np.uint8)
            mask[row - y0, start - x0:end - x0] = 255
            painted += width
    return seen, kept, painted


def _thinlines(args):
    import numpy as np
    from PIL import Image, ImageFilter
    from mediakit import mad, parse_box

    with Image.open(args.input) as source:
        original = source.convert("RGB")
    box = parse_box(args.box, original.width, original.height)
    x0, y0, x1, y1 = box
    pixels = np.asarray(original, dtype=np.uint8).copy()
    full_luma = pixels.astype(np.float32).mean(axis=2)
    mask = np.zeros((y1 - y0, x1 - x0), dtype=np.uint8)
    seen = kept = painted = 0
    if args.axis in ("rows", "both"):
        counts = _scan_axis0(full_luma, pixels, box, mask, args.lum, args.max_run, args.search)
        seen += counts[0]
        kept += counts[1]
        painted += counts[2]
    if args.axis in ("cols", "both"):
        counts = _scan_axis0(
            full_luma.T, pixels.transpose(1, 0, 2), (y0, x0, y1, x1), mask.T,
            args.lum, args.max_run, args.search,
        )
        seen += counts[0]
        kept += counts[1]
        painted += counts[2]

    mask_image = Image.fromarray(mask, mode="L").filter(ImageFilter.MaxFilter(5))
    feather = mask_image.filter(ImageFilter.GaussianBlur(args.feather))
    repaired = Image.fromarray(pixels, mode="RGB")
    softened = repaired.filter(ImageFilter.GaussianBlur(args.feather))
    # Blend only in the requested box; pixels beyond it remain exactly unchanged.
    dilated_mask = np.asarray(mask_image, dtype=np.uint8)
    alpha = np.asarray(feather, dtype=np.float32) / 255.0
    alpha *= dilated_mask > 0
    softened_array = np.asarray(softened, dtype=np.uint8)
    alpha_map = alpha[:, :, None]
    pixels[y0:y1, x0:x1] = np.rint(
        softened_array[y0:y1, x0:x1] * alpha_map + pixels[y0:y1, x0:x1] * (1 - alpha_map)
    ).astype(np.uint8)
    output = Image.fromarray(pixels, mode="RGB")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{args.output.stem}.", suffix=".tmp.png", dir=args.output.parent)
    os.close(fd)
    try:
        output.save(temp_name, format="PNG")
        os.replace(temp_name, args.output)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    input_box = original.crop(box)
    output_box = output.crop(box)
    return {"input": str(args.input), "output": str(args.output), "box": list(box),
            "runs_seen": seen, "runs_kept": kept, "masked_pixels": int(np.count_nonzero(mask)),
            "painted_pixels": painted, "mad_vs_input": mad(output_box, input_box),
            "thresholds": {"lum": args.lum, "max_run": args.max_run,
            "search": args.search, "feather": args.feather, "axis": args.axis}}


def _stitch(args):
    import numpy as np
    from mediakit import audio_mono, db, grab_frames, mad, probe

    sources = [Path(path) for path in args.parts] * args.repeat
    infos = [probe(path) for path in sources]
    first = infos[0]
    output = args.out
    output.parent.mkdir(parents=True, exist_ok=True)
    part = output.with_name(f"{output.stem}.part.mp4")
    if part.exists():
        part.unlink()
    command = ["ffmpeg", "-y", "-v", "error"]
    for path in sources:
        command.extend(["-i", str(path)])
    silence_indices = {}
    for index, info in enumerate(infos):
        if not info.has_audio:
            silence_indices[index] = len(sources) + len(silence_indices)
            command.extend(["-f", "lavfi", "-t", f"{info.duration:.9f}",
                            "-i", "anullsrc=r=48000:cl=stereo"])
    graph = []
    concat_inputs = []
    fps = f"{first.fps.numerator}/{first.fps.denominator}"
    for index, info in enumerate(infos):
        graph.append(f"[{index}:v:0]fps={fps},scale={first.width}:{first.height},setsar=1,format=yuv420p[v{index}]")
        if info.has_audio:
            graph.append(f"[{index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{index}]")
        else:
            graph.append(f"[{silence_indices[index]}:a:0]atrim=duration={info.duration:.9f},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{index}]")
        concat_inputs.append(f"[v{index}][a{index}]")
    graph.append(f"{''.join(concat_inputs)}concat=n={len(sources)}:v=1:a=1[outv][outa]")
    command.extend(["-filter_complex", ";".join(graph), "-map", "[outv]", "-map", "[outa]",
                    "-c:v", "libx264", "-crf", str(args.crf), "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", str(part)])
    try:
        _run(command)
        if not part.exists() or part.stat().st_size < args.min_bytes:
            raise ValueError(f"encoded output is below --min-bytes {args.min_bytes}")
        os.replace(part, output)
        info = probe(output)
        edge = grab_frames(output, indices=[0, info.frames - 1], exact=True)
        seam = mad(edge[info.frames - 1], edge[0])
        samples, rate = audio_mono(output)
        peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
        rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2))) if len(samples) else 0.0
        return {"output": str(output), "frames": info.frames, "fps": str(info.fps),
                "duration": info.duration, "has_audio": info.has_audio,
                "audio_peak_dbfs": db(peak), "audio_rms_dbfs": db(rms), "seam_mad": seam,
                "bytes": output.stat().st_size, "crf": args.crf, "min_bytes": args.min_bytes}
    except Exception:
        if part.exists():
            part.unlink()
        raise


def _parser():
    parser = argparse.ArgumentParser(description="Apply verified edits to existing media.")
    commands = parser.add_subparsers(dest="subcommand", required=True)
    stitch = commands.add_parser("stitch", help="concatenate clips and verify the encoded result")
    stitch.add_argument("--out", type=Path, required=True)
    stitch.add_argument("parts", nargs="+", type=Path)
    stitch.add_argument("--repeat", type=int, default=1)
    stitch.add_argument("--crf", type=int, default=17)
    stitch.add_argument("--min-bytes", type=int, default=10000)
    stitch.add_argument("--json", action="store_true")
    thin = commands.add_parser("thinlines", help="repair narrow dark runs within a box")
    thin.add_argument("--in", dest="input", type=Path, required=True)
    thin.add_argument("--out", dest="output", type=Path, required=True)
    thin.add_argument("--box", required=True)
    thin.add_argument("--axis", choices=("rows", "cols", "both"), default="rows")
    thin.add_argument("--lum", type=float, default=95)
    thin.add_argument("--max-run", type=int, default=26)
    thin.add_argument("--search", type=int, default=60)
    thin.add_argument("--feather", type=float, default=1.4)
    thin.add_argument("--json", action="store_true")
    return parser


def main(argv=None):
    require()
    parser = _parser()
    try:
        args = parser.parse_args(argv)
        if args.subcommand == "stitch":
            if args.repeat < 1 or args.crf < 0 or args.min_bytes < 1:
                parser.error("--repeat and --min-bytes must be positive; --crf must be non-negative")
            result = _stitch(args)
        else:
            if (not math.isfinite(args.lum) or args.max_run < 1 or args.search < 1
                    or not math.isfinite(args.feather) or args.feather < 0):
                parser.error("--lum must be finite; --max-run and --search positive; --feather non-negative")
            result = _thinlines(args)
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        elif args.subcommand == "stitch":
            print(f"{result['output']}: {result['frames']} frames at {result['fps']} fps, {result['duration']:.3f}s; CRF {args.crf}, minimum bytes {args.min_bytes}")
            print(f"audio: present; peak {result['audio_peak_dbfs']:.2f} dBFS, RMS {result['audio_rms_dbfs']:.2f} dBFS; seam MAD {result['seam_mad']:.4f}")
        else:
            print(f"runs seen {result['runs_seen']}, kept {result['runs_kept']}; masked {result['masked_pixels']} px, painted {result['painted_pixels']} px")
            print(f"box MAD against input: {result['mad_vs_input']:.6f}; thresholds axis {args.axis}, lum < {args.lum:g}, max-run {args.max_run}px, search {args.search}px, feather {args.feather:g}px")
        return 0
    except SystemExit as exc:
        return int(exc.code)
    except (OSError, ValueError, RuntimeError, ZeroDivisionError) as exc:
        print(str(exc), file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
