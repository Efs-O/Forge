#!/usr/bin/env python3
"""Contact sheets: sampled video frames, numbered image sets, region grids.

Three modes:
  video  -- a sheet of frames sampled over a time window, labelled with frame
           number and time; optionally cropped, magnified, and twin-cropped.
  images -- a numbered sheet of stills in letterboxed square cells, with an
           optional number-to-file manifest.
  grid   -- magnified crops of named regions, paged so each sheet stays
           readable, with a whole-image map of where each crop came from.

Sheets are evidence for a human to read, not pass/fail verdicts. Exit codes:
0 written, 2 bad arguments, 3 missing dependencies, 4 unreadable input.
"""

import sys
sys.dont_write_bytecode = True

import argparse
import json
import math
import os
import tempfile
from pathlib import Path

from mediakit_dependencies import require

# Checked before anything that needs them, so a missing package prints one
# plain install line and exits 3 instead of raising an import traceback.
require()

from PIL import Image, ImageDraw  # noqa: E402
from mediakit import grab_frames, parse_box, probe, tile  # noqa: E402


EXIT_USAGE = 2
EXIT_INPUT = 4
LABEL_H = 22
BG = (24, 24, 24)
PRESETS = ("thirds", "halves", "center")


def _die(message, code=EXIT_USAGE):
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(code)


def _image_size(path):
    """Read an image's dimensions and release the handle.

    The explicit close() also covers an image object whose context manager does
    not own its file: a sheet run should not leave file handles behind.
    """
    with Image.open(path) as opened:
        size = opened.size
        opened.close()
    return size


# ---------------------------------------------------------------- reporters --


class Reporter:
    """Text report by default; one JSON object on stdout when --json is set."""

    def __init__(self, json_mode):
        self.json_mode = json_mode
        self.written = []
        self.notes = []

    def line(self, text):
        if not self.json_mode:
            print(text)

    def note(self, text):
        self.notes.append(text)
        self.line(f"note: {text}")

    def wrote_image(self, path, tiles):
        path = Path(path)
        width, height = _image_size(path)
        size = path.stat().st_size
        record = {
            "path": str(path), "width": width, "height": height,
            "bytes": size, "tiles": tiles,
        }
        self.line(
            f"wrote {path} {width}x{height}px {size} bytes tiles={tiles}"
        )
        self.written.append(record)

    def wrote_text(self, path, rows):
        path = Path(path)
        size = path.stat().st_size
        record = {"path": str(path), "bytes": size, "rows": rows}
        self.line(f"wrote {path} {size} bytes rows={rows}")
        self.written.append(record)

    def finish(self, payload):
        if self.json_mode:
            data = dict(payload)
            data["written"] = self.written
            data["notes"] = self.notes
            print(json.dumps(data, ensure_ascii=False, sort_keys=True))


# ------------------------------------------------------------- file writing --


def _write_atomically(path, write):
    """Write through a temp name in the target folder, then os.replace."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(
        prefix=f"{path.stem}.", suffix=".tmp", dir=str(path.parent)
    )
    os.close(descriptor)
    temp = Path(name)
    try:
        write(temp)
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()
    return path


def _save_png(image, path):
    return _write_atomically(path, lambda temp: image.save(temp, format="PNG"))


def _save_text(text, path):
    return _write_atomically(path, lambda temp: temp.write_text(text, encoding="utf-8"))


def _numbered_pages(out, count, first_plain):
    """Page names: first_plain keeps page 1 at `out`, else `out-1.png`."""
    stem = Path(out)
    if stem.suffix.lower() == ".png":
        stem = stem.with_suffix("")
    paths = []
    for page in range(1, count + 1):
        if first_plain and page == 1:
            paths.append(stem.with_suffix(".png"))
        else:
            paths.append(Path(f"{stem}-{page}.png"))
    return paths


def _chunks(items, size):
    return [items[start:start + size] for start in range(0, len(items), size)]


# -------------------------------------------------------------- video mode --


def _parse_window(text):
    parts = text.split("-")
    if len(parts) != 2:
        _die(f"--window must be lo-hi in seconds, got: {text}")
    try:
        lo, hi = (float(part) for part in parts)
    except ValueError:
        _die(f"--window is not a pair of numbers: {text}")
    if not (math.isfinite(lo) and math.isfinite(hi)):
        _die(f"--window is not a pair of numbers: {text}")
    if lo < 0:
        _die("--window start cannot be negative")
    if hi <= lo:
        _die("--window end must be after its start")
    return lo, hi


def _zoom_box(box, width, height, zoom):
    """The shown rectangle: the centre 1/zoom of `box`, clamped to the canvas."""
    if box is None:
        box = (0, 0, width, height)
    x0, y0, x1, y1 = box
    centre_x = (x0 + x1) / 2.0
    centre_y = (y0 + y1) / 2.0
    half_w = (x1 - x0) / (2.0 * zoom)
    half_h = (y1 - y0) / (2.0 * zoom)
    left = max(0, math.floor(centre_x - half_w))
    top = max(0, math.floor(centre_y - half_h))
    right = min(width, math.ceil(centre_x + half_w))
    bottom = min(height, math.ceil(centre_y + half_h))
    if right - left < 2 or bottom - top < 2:
        _die("zoom leaves a region smaller than 2x2 pixels")
    return left, top, right, bottom


def _region_text(box, width, height):
    if box == (0, 0, width, height):
        return f"whole frame 0,0,{width},{height}"
    return f"{box[0]},{box[1]},{box[2]},{box[3]}"


def _sheet_from_frames(frames, indices, region, width, height, cols, tile_w, fps):
    pairs = []
    for index in indices:
        image = frames[index]
        if region != (0, 0, width, height):
            image = image.crop(region)
        seconds = index / float(fps)
        pairs.append((image, f"f{index} {seconds:.3f}s"))
    return tile(pairs, cols=cols, tile_w=tile_w, label_h=LABEL_H)


def cmd_video(args, rep):
    clip = Path(args.clip)
    if not clip.exists():
        _die(f"input not found: {clip}", EXIT_INPUT)
    try:
        info = probe(clip)
    except (RuntimeError, ValueError) as exc:
        _die(f"cannot read {clip}: {exc}", EXIT_INPUT)
    if info.frames < 1 or info.fps <= 0:
        _die(f"clip has no decodable frames: {clip}", EXIT_INPUT)

    fps = info.fps
    duration = info.duration if info.duration > 0 else float(info.frames) / float(fps)
    lo, hi = 0.0, duration
    if args.window:
        lo, hi = _parse_window(args.window)
    if hi > duration:
        rep.note(
            f"window clamped to clip length: {lo:.3f}-{duration:.3f} s of {duration:.3f} s"
        )
        hi = duration
    if lo >= duration:
        _die(f"window starts at or after the clip ends ({duration:.3f} s)")

    first = max(0, min(info.frames - 1, math.floor(float(lo) * float(fps))))
    last = max(0, min(info.frames - 1, math.ceil(float(hi) * float(fps)) - 1))
    span = last - first + 1
    if args.count is not None:
        wanted = min(args.count, span)
        if wanted < args.count:
            rep.note(
                f"--count {args.count} is more than the {span} frames in the window; "
                f"using {wanted}"
            )
        if wanted <= 1:
            indices = [first]
        else:
            indices = [
                first + round(offset * (span - 1) / (wanted - 1))
                for offset in range(wanted)
            ]
        sampling = {"count": wanted}
        sampling_text = f"count {wanted} spread evenly over frames {first}-{last}"
    else:
        indices = list(range(first, last + 1, args.step))
        sampling = {"step": args.step}
        sampling_text = f"step {args.step} over frames {first}-{last}"
    if not indices:
        _die("the window contains no frames")

    primary_box = None
    twin_box = None
    if args.crop_twin:
        if not args.box:
            _die("--crop-twin needs --box: the twin is the cropped view")
        twin_box = parse_box(args.box, info.width, info.height)
        rep.note("box applies to the crop twin; the primary sheet shows whole frames")
    elif args.box:
        primary_box = parse_box(args.box, info.width, info.height)

    primary_region = _zoom_box(primary_box, info.width, info.height, args.zoom)
    twin_region = None
    if twin_box is not None:
        twin_region = _zoom_box(twin_box, info.width, info.height, args.zoom)

    rep.line(
        f"clip {clip} {info.width}x{info.height} "
        f"{info.fps.numerator}/{info.fps.denominator} fps {info.frames} frames"
    )
    rep.line(
        f"window {lo:.3f}-{hi:.3f} s -> {len(indices)} tiles; sampling: {sampling_text}"
    )
    rep.line(
        f"layout: cols {args.cols}, tile-w {args.tile_w}, label-h {LABEL_H}, "
        f"exact {'on' if args.exact else 'off'}"
    )
    rep.line(
        f"primary region: {_region_text(primary_region, info.width, info.height)} "
        f"zoom {args.zoom:g}"
    )
    if twin_region is not None:
        rep.line(
            f"twin region: {_region_text(twin_region, info.width, info.height)} "
            f"zoom {args.zoom:g}"
        )

    try:
        frames = grab_frames(clip, indices=indices, exact=args.exact)
    except (RuntimeError, ValueError) as exc:
        _die(f"cannot decode {clip}: {exc}", EXIT_INPUT)
    if not frames:
        _die(f"decoder returned no frames from {clip}", EXIT_INPUT)

    out = Path(args.out)
    if out.suffix.lower() != ".png":
        out = Path(f"{out}.png") if not out.suffix else out.with_suffix(".png")
    sheet = _sheet_from_frames(
        frames, indices, primary_region, info.width, info.height,
        args.cols, args.tile_w, fps,
    )
    _save_png(sheet, out)
    rep.wrote_image(out, len(indices))
    if twin_region is not None:
        twin = _sheet_from_frames(
            frames, indices, twin_region, info.width, info.height,
            args.cols, args.tile_w, fps,
        )
        twin_path = out.with_name(f"{out.stem}-crop.png")
        _save_png(twin, twin_path)
        rep.wrote_image(twin_path, len(indices))

    rep.finish({
        "mode": "video",
        "clip": str(clip),
        "width": info.width,
        "height": info.height,
        "fps": float(fps),
        "fps_fraction": f"{info.fps.numerator}/{info.fps.denominator}",
        "frames": info.frames,
        "duration_s": duration,
        "window_s": [lo, hi],
        "sampling": sampling,
        "frame_indices": indices,
        "tiles": len(indices),
        "cols": args.cols,
        "tile_w": args.tile_w,
        "box": args.box,
        "zoom": args.zoom,
        "exact": args.exact,
        "crop_twin": args.crop_twin,
        "regions": {
            "primary": _region_text(primary_region, info.width, info.height),
            "twin": (
                _region_text(twin_region, info.width, info.height) if twin_region is not None else None
            ),
        },
    })
    return 0


# ------------------------------------------------------------- images mode --


def _letterbox(image, cell):
    """Resize into a square cell, centred, background-filled on both sides."""
    side = max(1, cell)
    scale = min(side / image.width, side / image.height)
    width = max(1, round(image.width * scale))
    height = max(1, round(image.height * scale))
    resized = image.resize((width, height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (side, side), BG)
    canvas.paste(resized, ((side - width) // 2, (side - height) // 2))
    return canvas


def _read_order_file(path):
    order = Path(path)
    if not order.exists():
        _die(f"order file not found: {order}", EXIT_INPUT)
    text = order.read_text(encoding="utf-8", errors="replace")
    files = []
    for line in text.splitlines():
        entry = line.strip()
        if not entry or entry.startswith("#"):
            continue
        candidate = Path(entry)
        if not candidate.is_absolute():
            candidate = order.parent / candidate
        files.append(str(candidate))
    return files


def cmd_images(args, rep):
    if args.order_file and args.files:
        _die("give images as arguments or in --order-file, not both")
    files = _read_order_file(args.order_file) if args.order_file else list(args.files)
    if not files:
        _die("no images given: list them as arguments or use --order-file")

    opened = []
    for entry in files:
        path = Path(entry)
        if not path.exists():
            _die(f"input not found: {path}", EXIT_INPUT)
        try:
            # Letterbox while the source is open, then keep only the small cell:
            # a folder of large stills must not all be resident at once, and only
            # one source handle may be open at a time.
            with Image.open(path) as source:
                cell = _letterbox(source.convert("RGB"), args.cell)
                source.close()
        except (OSError, ValueError) as exc:
            _die(f"cannot read {path}: {exc}", EXIT_INPUT)
        opened.append((entry, cell))

    per_page = max(1, args.cols * args.rows)
    pages = math.ceil(len(opened) / per_page)
    rep.line(
        f"{len(opened)} images in cells of {args.cell}px, cols {args.cols}, "
        f"rows {args.rows}, numbering from {args.number_from}, "
        f"per sheet {per_page}, {pages} sheet(s)"
    )

    paths = _numbered_pages(args.out, pages, first_plain=True)
    numbers = []
    for page, path in enumerate(paths):
        group = opened[page * per_page:(page + 1) * per_page]
        pairs = []
        for offset, (entry, cell) in enumerate(group):
            number = args.number_from + page * per_page + offset
            numbers.append((number, entry))
            pairs.append((cell, str(number)))
        sheet = tile(pairs, cols=args.cols, tile_w=args.cell, label_h=LABEL_H)
        _save_png(sheet, path)
        rep.wrote_image(path, len(pairs))

    if args.manifest:
        first = paths[0]
        manifest = first.with_name(f"{first.stem}-manifest.md")
        lines = ["| number | file |", "|---|---|"]
        lines += [f"| {number} | {entry} |" for number, entry in numbers]
        _save_text("\n".join(lines) + "\n", manifest)
        rep.wrote_text(manifest, len(numbers))

    rep.finish({
        "mode": "images",
        "count": len(opened),
        "cols": args.cols,
        "rows": args.rows,
        "cell": args.cell,
        "number_from": args.number_from,
        "per_sheet": per_page,
        "pages": pages,
        "order_file": args.order_file,
        "manifest": args.manifest,
        "numbers": [{"number": number, "file": entry} for number, entry in numbers],
    })
    return 0


# --------------------------------------------------------------- grid mode --


def _preset_regions(preset):
    if preset == "thirds":
        return [
            (
                f"thirds_r{row + 1}c{col + 1}",
                f"{col / 3:.4f},{row / 3:.4f},{(col + 1) / 3:.4f},{(row + 1) / 3:.4f}",
            )
            for row in range(3)
            for col in range(3)
        ]
    if preset == "halves":
        return [
            (
                f"halves_r{row + 1}c{col + 1}",
                f"{col / 2:.4f},{row / 2:.4f},{(col + 1) / 2:.4f},{(row + 1) / 2:.4f}",
            )
            for row in range(2)
            for col in range(2)
        ]
    return [("center", "0.2500,0.2500,0.7500,0.7500")]


def _load_region_file(path):
    file = Path(path)
    if not file.exists():
        _die(f"region file not found: {file}", EXIT_INPUT)
    text = file.read_text(encoding="utf-8", errors="replace")
    stripped = text.strip()
    regions = []
    if stripped.startswith("{"):
        try:
            data = json.loads(stripped)
        except ValueError as exc:
            _die(f"{file} is not valid JSON: {exc}")
        if not isinstance(data, dict):
            _die(f"{file} must hold an object of name: box")
        for name, box in data.items():
            if isinstance(box, (list, tuple)):
                box = ",".join(str(value) for value in box)
            if not isinstance(box, str):
                _die(f"{file}: region {name} is not a box")
            regions.append((str(name).strip(), box.strip()))
        return regions
    for line in text.splitlines():
        entry = line.split("#", 1)[0].strip()
        if not entry:
            continue
        name, separator, box = entry.partition(":")
        if not separator or not box.strip():
            _die(f"{file}: line '{entry}' needs the form name: x0,y0,x1,y1")
        regions.append((name.strip().strip("\"'"), box.strip().strip("\"'")))
    return regions


def _parse_regions(args):
    regions = []
    for item in args.region or []:
        name, separator, box = item.partition(":")
        if not separator or not name.strip() or not box.strip():
            _die(f"--region needs name:x0,y0,x1,y1, got: {item}")
        regions.append((name.strip(), box.strip()))
    if args.region_file:
        regions.extend(_load_region_file(args.region_file))
    for preset in args.preset or []:
        regions.extend(_preset_regions(preset))
    seen = set()
    for name, _box in regions:
        if name in seen:
            _die(f"duplicate region name: {name}")
        seen.add(name)
    if not regions:
        _die("grid needs --region, --region-file, or --preset")
    return regions


def _pad_to_aspect(tiles):
    """Give every tile the tallest aspect so cells line up across every sheet."""
    if not tiles:
        return tiles
    aspect = max(
        image.height / image.width for image, _label, _crop_width in tiles
    )
    padded = []
    for image, label, crop_width in tiles:
        height = max(image.height, math.ceil(image.width * aspect))
        if height == image.height:
            padded.append((image, label, crop_width))
            continue
        canvas = Image.new("RGB", (image.width, height), BG)
        canvas.paste(image, (0, (height - image.height) // 2))
        padded.append((canvas, label, crop_width))
    return padded


def _scaled_crop(crop, scale):
    width = max(1, round(crop.width * scale))
    height = max(1, round(crop.height * scale))
    if (width, height) == (crop.width, crop.height):
        return crop
    resampling = (
        Image.Resampling.NEAREST if scale >= 1 else Image.Resampling.LANCZOS
    )
    return crop.resize((width, height), resampling)


def _parse_band(text, height):
    parts = text.split("-")
    if len(parts) != 2:
        _die(f"--bands entry '{text}' must be y0-y1")
    try:
        lo, hi = (float(part) for part in parts)
    except ValueError:
        _die(f"--bands entry '{text}' is not a pair of numbers")
    if any(value > 1 for value in (lo, hi)):
        if not (lo.is_integer() and hi.is_integer()):
            _die(f"pixel band values must be integers: {text}")
        top, bottom = int(lo), int(hi)
    else:
        if lo < 0 or hi > 1:
            _die(f"fraction band values must be in 0..1: {text}")
        top, bottom = round(lo * height), round(hi * height)
    top, bottom = max(0, min(height, top)), max(0, min(height, bottom))
    if bottom <= top:
        _die(f"band '{text}' has no rows after clamping to {height}px")
    return top, bottom


def _overview_band(image, regions, max_width, overview, label):
    width = max(1, min(image.width, round(max_width * overview)))
    height = max(1, round(image.height * width / image.width))
    scaled = image.resize((width, height), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(scaled)
    for _name, box_text in regions:
        try:
            x0, y0, x1, y1 = parse_box(box_text, image.width, image.height)
        except ValueError:
            continue
        draw.rectangle(
            (
                max(0, round(x0 * width / image.width)),
                max(0, round(y0 * height / image.height)),
                min(width - 1, round(x1 * width / image.width) - 1),
                min(height - 1, round(y1 * height / image.height) - 1),
            ),
            outline=(235, 235, 235),
            width=2,
        )
    return tile([(scaled, label)], cols=1, tile_w=width, label_h=LABEL_H)


def cmd_grid(args, rep):
    opened = []
    for entry in args.images:
        path = Path(entry)
        if not path.exists():
            _die(f"input not found: {path}", EXIT_INPUT)
        try:
            # convert() returns an independent copy, so the source handle can be
            # closed before the next image is opened.
            with Image.open(path) as source:
                image = source.convert("RGB")
                source.close()
        except (OSError, ValueError) as exc:
            _die(f"cannot read {path}: {exc}", EXIT_INPUT)
        opened.append((path, image))

    bands = [token for token in (args.bands or "").split(",") if token.strip()]
    if bands and (args.region or args.region_file or args.preset):
        _die("--bands defines the regions: do not combine it with "
             "--region, --region-file, or --preset")
    if not bands:
        regions = _parse_regions(args)
        rep.line(f"{len(regions)} region(s): "
                 + ", ".join(f"{name} {box}" for name, box in regions))

    rep.line(
        f"layout: scale {args.scale:g}, per-sheet {args.per_sheet}, "
        f"max-width {args.max_width}, overview {args.overview:g}, "
        f"label-h {LABEL_H}"
    )
    for path, image in opened:
        rep.line(f"image {path} {image.width}x{image.height}")

    if bands:
        if args.overview:
            rep.note("overview skipped in band mode: every tile already spans the width")
        pages = []
        all_scales = []
        for token in bands:
            pairs = []
            for path, image in opened:
                top, bottom = _parse_band(token, image.height)
                crop = image.crop((0, top, image.width, bottom))
                pairs.append((
                    _scaled_crop(crop, args.scale), f"{path.stem} {token}", crop.width,
                ))
            pairs = _pad_to_aspect(pairs)
            cols = max(1, min(len(pairs), args.per_sheet))
            tile_w = max(1, min(max(pair[0].width for pair in pairs), args.max_width // cols))
            scales = [tile_w / crop_width for _image, _label, crop_width in pairs]
            all_scales.extend(scales)
            sheet = tile(
                [(image, label) for image, label, _crop_width in pairs],
                cols=cols, tile_w=tile_w, label_h=LABEL_H,
            )
            pages.append((token, sheet, len(pairs), min(scales), max(scales)))
        if all_scales and max(all_scales) < args.scale * 0.999:
            rep.note("--scale capped by --max-width; raise --max-width or lower --per-sheet")
        paths = _numbered_pages(args.out, len(pages), first_plain=False)
        for (token, sheet, tiles, low, high), path in zip(pages, paths):
            rep.line(
                f"band {token}: magnification {low:.2f}x-{high:.2f}x "
                f"(asked {args.scale:g}x)"
            )
            _save_png(sheet, path)
            rep.wrote_image(path, tiles)
        rep.finish({
            "mode": "grid",
            "images": [str(path) for path, _image in opened],
            "bands": bands,
            "scale": args.scale,
            "effective_scale": (
                [min(all_scales), max(all_scales)] if all_scales else [0.0, 0.0]
            ),
            "per_sheet": args.per_sheet,
            "max_width": args.max_width,
            "overview": 0.0,
            "sheets": len(pages),
        })
        return 0

    multiple = len(opened) > 1
    tiles = []
    for path, image in opened:
        for name, box_text in regions:
            try:
                box = parse_box(box_text, image.width, image.height)
            except ValueError as exc:
                _die(f"region {name} is not valid for {path}: {exc}")
            label = f"{path.stem}:{name}" if multiple else name
            crop = image.crop(box)
            tiles.append((_scaled_crop(crop, args.scale), label, crop.width))

    tiles = _pad_to_aspect(tiles)
    cols = max(1, min(args.per_sheet, len(tiles)))
    tile_w = max(1, min(max(pair[0].width for pair in tiles), args.max_width // cols))
    all_scales = [tile_w / crop_width for _image, _label, crop_width in tiles]
    if all_scales and max(all_scales) < args.scale * 0.999:
        rep.note("--scale capped by --max-width; raise --max-width or lower --per-sheet")
    groups = _chunks(tiles, args.per_sheet)
    paths = _numbered_pages(args.out, len(groups), first_plain=False)
    rep.line(f"tile-w {tile_w}px, {len(groups)} sheet(s) of up to {args.per_sheet} tiles")

    bands_of_images = None
    if args.overview:
        bands_of_images = [
            _overview_band(
                image, regions, args.max_width, args.overview,
                f"overview {path.stem}: regions marked" if multiple else "overview: regions marked",
            )
            for path, image in opened
        ]
    for group, path in zip(groups, paths):
        scales = [tile_w / crop_width for _image, _label, crop_width in group]
        rep.line(
            f"magnification {min(scales):.2f}x-{max(scales):.2f}x "
            f"(asked {args.scale:g}x)"
        )
        sheet = tile(
            [(image, label) for image, label, _crop_width in group],
            cols=min(args.per_sheet, len(group)), tile_w=tile_w, label_h=LABEL_H,
        )
        if bands_of_images:
            header = sum(band.height for band in bands_of_images)
            width = max([sheet.width] + [band.width for band in bands_of_images])
            canvas = Image.new("RGB", (width, header + sheet.height), BG)
            offset = 0
            for band in bands_of_images:
                canvas.paste(band, (0, offset))
                offset += band.height
            canvas.paste(sheet, (0, header))
            sheet = canvas
        _save_png(sheet, path)
        rep.wrote_image(path, len(group))

    rep.finish({
        "mode": "grid",
        "images": [str(path) for path, _image in opened],
        "regions": [{"name": name, "box": box} for name, box in regions],
        "scale": args.scale,
        "per_sheet": args.per_sheet,
        "max_width": args.max_width,
        "overview": args.overview,
        "tile_w": tile_w,
        "effective_scale": [min(all_scales), max(all_scales)],
        "sheets": len(groups),
    })
    return 0


# ------------------------------------------------------------------ parser --


def _add_common(subparser, out_help):
    subparser.add_argument("--out", required=True, help=out_help)
    subparser.add_argument(
        "--json", action="store_true",
        help="print one JSON object instead of the text report",
    )


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="sheet.py",
        description="Build contact sheets from clips and images.",
        epilog=(
            "Boxes are fractions of width and height (0..1); if any value is "
            "above 1, all four are integer pixels. Frame rate comes from the "
            "file. Exit codes: 0 written, 2 bad arguments, 3 missing "
            "dependencies, 4 unreadable input."
        ),
    )
    modes = parser.add_subparsers(dest="mode", required=True, metavar="MODE")

    video = modes.add_parser(
        "video", help="sheet of frames sampled over a time window",
    )
    video.add_argument("clip", help="video file")
    video.add_argument(
        "--window", help="lo-hi in seconds (default: the whole clip, clamped)",
    )
    sampling = video.add_mutually_exclusive_group()
    sampling.add_argument(
        "--step", type=int, default=2, help="every Nth frame in the window (default 2)",
    )
    sampling.add_argument(
        "--count", type=int,
        help="N frames spread evenly over the window (exclusive with --step)",
    )
    video.add_argument(
        "--crop-twin", action="store_true",
        help="also write <out>-crop.png of the same frames cropped to --box",
    )
    video.add_argument(
        "--exact", action="store_true",
        help="decode each frame on its own instead of in one pass",
    )
    video.add_argument("--cols", type=int, default=5, help="tiles per row (default 5)")
    video.add_argument("--tile-w", type=int, default=320, help="tile width in px (default 320)")
    video.add_argument(
        "--box", help="crop to x0,y0,x1,y1 before tiling",
    )
    video.add_argument(
        "--zoom", type=float, default=1.0,
        help="magnify the shown region: 2.0 shows its centre half (default 1.0)",
    )
    _add_common(video, "sheet PNG to write")

    images = modes.add_parser("images", help="numbered sheet of still images")
    images.add_argument("files", nargs="*", help="image files, in the order to number them")
    images.add_argument("--cols", type=int, default=5, help="cells per row (default 5)")
    images.add_argument("--rows", type=int, default=7, help="rows per sheet (default 7)")
    images.add_argument("--cell", type=int, default=340, help="square cell size in px (default 340)")
    images.add_argument(
        "--number-from", type=int, default=1,
        help="first number on the sheet (default 1, for continuing a set)",
    )
    images.add_argument(
        "--order-file",
        help="file listing image paths one per line, used instead of the arguments",
    )
    images.add_argument(
        "--manifest", action="store_true",
        help="also write <out>-manifest.md mapping number to file",
    )
    _add_common(images, "first-page sheet PNG; later pages get -2, -3 and so on")

    grid = modes.add_parser("grid", help="magnified crops of named image regions")
    grid.add_argument("images", nargs="+", help="image files")
    grid.add_argument(
        "--region", action="append", metavar="name:x0,y0,x1,y1",
        help="one named region; repeat for more",
    )
    grid.add_argument(
        "--region-file",
        help="JSON object or flat 'name: x0,y0,x1,y1' lines mapping name to box",
    )
    grid.add_argument(
        "--preset", action="append", choices=list(PRESETS),
        help="neutral geometry presets: thirds (3x3), halves (2x2), center; repeatable",
    )
    grid.add_argument("--scale", type=float, default=3.0, help="crop magnification (default 3)")
    grid.add_argument("--per-sheet", type=int, default=3, help="tiles per sheet (default 3)")
    grid.add_argument("--max-width", type=int, default=1600, help="sheet width cap in px (default 1600)")
    grid.add_argument(
        "--overview", type=float, default=0.5,
        help="whole-image map on each sheet, 0 disables it (default 0.5)",
    )
    grid.add_argument(
        "--bands",
        help="y0-y1,y0-y1 ... the same horizontal bands across images, side by side",
    )
    _add_common(grid, "stem; pages become <stem>-1.png, <stem>-2.png and so on")
    return parser


def _validate(args):
    limits = (
        ("cols", getattr(args, "cols", None)),
        ("rows", getattr(args, "rows", None)),
        ("cell", getattr(args, "cell", None)),
        ("tile-w", getattr(args, "tile_w", None)),
        ("per-sheet", getattr(args, "per_sheet", None)),
        ("max-width", getattr(args, "max_width", None)),
        ("step", getattr(args, "step", None)),
        ("count", getattr(args, "count", None)),
    )
    for name, value in limits:
        if value is not None and value < 1:
            _die(f"--{name} must be at least 1")
    if args.mode == "video":
        if not math.isfinite(args.zoom) or args.zoom <= 0:
            _die("--zoom must be a positive number")
    if args.mode == "grid":
        if not math.isfinite(args.scale) or args.scale <= 0:
            _die("--scale must be a positive number")
        if not 0 <= args.overview <= 1:
            _die("--overview must be between 0 and 1")


def main(argv=None):
    args = _build_parser().parse_args(argv)
    _validate(args)
    reporter = Reporter(args.json)
    if args.mode == "video":
        return cmd_video(args, reporter)
    if args.mode == "images":
        return cmd_images(args, reporter)
    return cmd_grid(args, reporter)


if __name__ == "__main__":
    raise SystemExit(main())
