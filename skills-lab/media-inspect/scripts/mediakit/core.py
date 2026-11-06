"""Small, dependency-light ffmpeg and Pillow primitives for media tools."""

from __future__ import annotations

import json
import math
import subprocess
import tempfile
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Iterable, Sequence

from mediakit_dependencies import require

import numpy as np
from PIL import Image, ImageDraw, ImageFont


@dataclass(frozen=True)
class Probe:
    width: int
    height: int
    fps: Fraction
    frames: int
    duration: float
    has_audio: bool


def _run(args: Sequence[str], cwd: str | Path | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        raise RuntimeError(detail.strip()) from exc


def _fraction(value: str) -> Fraction:
    try:
        parsed = Fraction(value)
    except (ValueError, ZeroDivisionError) as exc:
        raise ValueError(f"invalid frame rate: {value}") from exc
    if parsed <= 0:
        raise ValueError(f"invalid frame rate: {value}")
    return parsed


def probe(path: str | Path) -> Probe:
    """Read dimensions, frame rate, frame count, duration, and audio presence."""
    result = _run([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ])
    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if video is None:
        raise ValueError(f"no video stream: {path}")
    fps = _fraction(video.get("avg_frame_rate") or video.get("r_frame_rate", "0/0"))
    frame_count = int(video.get("nb_frames") or 0)
    duration = float(video.get("duration") or data.get("format", {}).get("duration") or 0.0)
    if frame_count <= 0 and duration > 0:
        frame_count = round(duration * fps)
    if frame_count <= 0:
        counted = _run([
            "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
            "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", str(path),
        ])
        frame_count = int(counted.stdout.strip() or "0")
    return Probe(
        width=int(video["width"]), height=int(video["height"]), fps=fps,
        frames=frame_count, duration=duration, has_audio=any(
            stream.get("codec_type") == "audio" for stream in streams
        ),
    )


def parse_box(text: str, width: int, height: int) -> tuple[int, int, int, int]:
    """Parse a fractional or pixel rectangle and clamp it to the image canvas."""
    try:
        values = [float(part.strip()) for part in text.split(",")]
    except ValueError as exc:
        raise ValueError("box must be x0,y0,x1,y1") from exc
    if len(values) != 4 or not all(math.isfinite(value) for value in values):
        raise ValueError("box must contain four finite values")
    pixels = any(value > 1 for value in values)
    if pixels:
        if not all(value.is_integer() for value in values):
            raise ValueError("pixel box coordinates must all be integers")
        x0, y0, x1, y1 = (int(value) for value in values)
    else:
        if any(value < 0 or value > 1 for value in values):
            raise ValueError("fraction box coordinates must be in 0..1")
        x0, y0, x1, y1 = (round(values[0] * width), round(values[1] * height),
                           round(values[2] * width), round(values[3] * height))
    x0, x1 = max(0, min(width, x0)), max(0, min(width, x1))
    y0, y1 = max(0, min(height, y0)), max(0, min(height, y1))
    if x1 <= x0 or y1 <= y0:
        raise ValueError("box must have positive area after clamping")
    return x0, y0, x1, y1


def even_crop(box: tuple[int, int, int, int]) -> str:
    """Return an ffmpeg crop expression with even dimensions and origin."""
    x0, y0, x1, y1 = box
    width, height = x1 - x0, y1 - y0
    width -= width % 2
    height -= height % 2
    x0 -= x0 % 2
    y0 -= y0 % 2
    if width < 2 or height < 2:
        raise ValueError("crop must be at least 2x2 pixels")
    return f"crop={width}:{height}:{x0}:{y0}"


def ydif_series(path: str | Path, box: str | tuple[int, int, int, int] | None = None) -> np.ndarray:
    """Extract one signalstats YDIF (frame-to-previous-frame luma change) per frame."""
    path = Path(path).resolve()
    with tempfile.TemporaryDirectory(prefix="mediakit-") as temp:
        metadata = Path(temp) / "signal.txt"
        filters = ""
        if box is not None:
            info = probe(path)
            parsed = parse_box(box, info.width, info.height) if isinstance(box, str) else box
            filters = even_crop(parsed) + ","
        filters += "signalstats,metadata=print:file=signal.txt"
        _run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", filters, "-f", "null", "-"], cwd=temp)
        if not metadata.exists() or metadata.stat().st_size == 0:
            raise RuntimeError("ffmpeg did not write signalstats metadata")
        values: list[float] = []
        for line in metadata.read_text(encoding="utf-8", errors="replace").splitlines():
            if "lavfi.signalstats.YDIF=" in line:
                values.append(float(line.rsplit("=", 1)[1]))
        if not values:
            raise RuntimeError("signalstats metadata contains no YDIF values")
        return np.asarray(values, dtype=np.float32)


def grab_frames(
    path: str | Path,
    indices: Iterable[int] | None = None,
    step: int | None = None,
    exact: bool = False,
) -> dict[int, Image.Image]:
    """Decode selected frames in one pass, or one-by-one when exact=True."""
    info = probe(path)
    if step is not None and step < 1:
        raise ValueError("step must be positive")
    if indices is None:
        selected = list(range(0, info.frames, step or 1))
    else:
        selected = sorted(set(int(index) for index in indices))
    if any(index < 0 or index >= info.frames for index in selected):
        raise ValueError("frame index outside clip")
    if not selected:
        return {}
    with tempfile.TemporaryDirectory(prefix="mediakit-") as temp:
        output = Path(temp) / "%08d.png"
        if exact:
            results: dict[int, Image.Image] = {}
            for index in selected:
                _run([
                    "ffmpeg", "-v", "error", "-i", str(path), "-vf", f"select=eq(n\\,{index})",
                    "-fps_mode", "passthrough", "-frames:v", "1",
                    str(Path(temp) / f"{index:08d}.png"),
                ])
                image_path = Path(temp) / f"{index:08d}.png"
                if not image_path.exists():
                    raise RuntimeError("decoded 0 frames; expected 1")
                results[index] = Image.open(image_path).convert("RGB").copy()
            return results
        if indices is None:
            selected_step = step or 1
            expression = f"select=not(mod(n\\,{selected_step}))"
            output_indices = selected
        else:
            terms = "+".join(f"eq(n\\,{index})" for index in selected)
            expression = f"select={terms}"
            output_indices = selected
        _run([
            "ffmpeg", "-v", "error", "-i", str(path), "-vf", expression,
            "-fps_mode", "passthrough", str(output),
        ])
        image_paths = sorted(Path(temp).glob("*.png"))
        if len(image_paths) != len(output_indices):
            raise RuntimeError(f"decoded {len(image_paths)} frames; expected {len(output_indices)}")
        return {
            index: Image.open(image_path).convert("RGB").copy()
            for index, image_path in zip(output_indices, image_paths)
        }


def audio_mono(path: str | Path, rate: int | None = None) -> tuple[np.ndarray, int]:
    """Decode audio to mono float32 samples in [-1, 1]."""
    info = probe(path)
    if not info.has_audio:
        raise ValueError(f"no audio stream: {path}")
    if rate is None:
        result = _run([
            "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
            "stream=sample_rate", "-of", "default=nw=1:nk=1", str(path),
        ])
        rate = int(result.stdout.strip())
    try:
        raw = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1",
             "-ar", str(rate), "-f", "f32le", "-"],
            check=True, capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", b"") or str(exc).encode()
        raise RuntimeError(detail.decode("utf-8", errors="replace").strip()) from exc
    samples = np.frombuffer(raw.stdout, dtype=np.float32).copy()
    return np.clip(samples, -1.0, 1.0), rate


def frame_envelope(samples: np.ndarray, rate: int, fps: Fraction | float, n_frames: int) -> np.ndarray:
    """Return per-frame RMS, trimming or zero-padding to exactly n_frames."""
    fps_value = float(fps)
    if rate <= 0 or fps_value <= 0 or n_frames < 0:
        raise ValueError("rate and fps must be positive and n_frames non-negative")
    edges = np.round(np.arange(n_frames + 1) * rate / fps_value).astype(int)
    result = np.zeros(n_frames, dtype=np.float32)
    for index, (start, end) in enumerate(zip(edges[:-1], edges[1:])):
        chunk = samples[start:min(end, len(samples))]
        if len(chunk):
            result[index] = np.sqrt(np.mean(np.square(chunk), dtype=np.float64))
    return result


def db(x: float) -> float:
    return 20.0 * math.log10(max(float(x), 1e-9))


def luma(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("L"), dtype=np.float32)


def mad(a: Image.Image, b: Image.Image) -> float:
    first, second = luma(a), luma(b)
    if first.shape != second.shape:
        resized = b.convert("L").resize((a.width, a.height), Image.Resampling.LANCZOS)
        second = np.asarray(resized, dtype=np.float32)
    return float(np.mean(np.abs(first - second)))


def stats(arr: np.ndarray) -> dict[str, float | int]:
    values = np.asarray(arr, dtype=np.float64).ravel()
    if values.size == 0:
        raise ValueError("stats requires at least one value")
    return {
        "mean": float(np.mean(values)), "median": float(np.median(values)),
        "p90": float(np.percentile(values, 90)), "max": float(np.max(values)),
        "argmax": int(np.argmax(values)),
    }


def flag_runs(arr: np.ndarray, factor: float) -> tuple[float, list[int], list[tuple[int, int, float]]]:
    """Flag values above mean*factor and group adjacent indices into runs."""
    values = np.asarray(arr, dtype=np.float64).ravel()
    if values.size == 0 or factor < 0:
        raise ValueError("flag_runs requires data and a non-negative factor")
    threshold = float(np.mean(values) * factor)
    flagged = np.flatnonzero(values > threshold).tolist()
    runs: list[tuple[int, int, float]] = []
    if flagged:
        start = previous = flagged[0]
        peak = float(values[start])
        for index in flagged[1:]:
            if index != previous + 1:
                runs.append((start, previous, peak))
                start = index
                peak = float(values[index])
            else:
                peak = max(peak, float(values[index]))
            previous = index
        runs.append((start, previous, peak))
    return threshold, flagged, runs


def autocorr_candidates(arr: np.ndarray, min_period: int, top: int = 3) -> list[tuple[int, float]]:
    """Rank positive-lag Pearson correlations of a series with itself."""
    values = np.asarray(arr, dtype=np.float64).ravel()
    values = values - np.mean(values) if values.size else values
    if min_period < 1 or top < 1:
        raise ValueError("min_period and top must be positive")
    candidates: list[tuple[int, float]] = []
    for lag in range(min_period, max(min_period, len(values) // 2) + 1):
        left, right = values[:-lag], values[lag:]
        denom = float(np.linalg.norm(left) * np.linalg.norm(right))
        corr = float(np.dot(left, right) / denom) if denom else 0.0
        candidates.append((lag, corr))
    return sorted(candidates, key=lambda pair: pair[1], reverse=True)[:top]


def font(size: int) -> ImageFont.ImageFont:
    """Load a common TrueType font when available, otherwise Pillow's default."""
    for candidate in ("DejaVuSans.ttf", "Arial.ttf", "LiberationSans-Regular.ttf"):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def tile(
    images_with_labels: Sequence[tuple[Image.Image, str]], cols: int, tile_w: int,
    label_h: int = 22, bg: tuple[int, int, int] = (24, 24, 24),
) -> Image.Image:
    """Arrange labelled images into a uniformly sized contact sheet."""
    if cols < 1 or tile_w < 1 or label_h < 0:
        raise ValueError("cols/tile_w must be positive and label_h non-negative")
    if not images_with_labels:
        raise ValueError("tile requires at least one image")
    scaled = [
        (
            image.convert("RGB").resize(
                (tile_w, max(1, round(image.height * tile_w / image.width))),
                Image.Resampling.LANCZOS,
            ),
            label,
        )
        for image, label in images_with_labels
    ]
    tile_h = max(image.height for image, _ in scaled)
    rows = math.ceil(len(images_with_labels) / cols)
    sheet = Image.new("RGB", (cols * tile_w, rows * (tile_h + label_h)), bg)
    draw = ImageDraw.Draw(sheet)
    label_font = font(max(10, min(16, label_h - 4))) if label_h else None
    for index, (image, label) in enumerate(scaled):
        x, y = (index % cols) * tile_w, (index // cols) * (tile_h + label_h)
        sheet.paste(image, (x + (tile_w - image.width) // 2, y))
        if label_h and label_font:
            draw.text((x + 4, y + tile_h + 2), label, font=label_font, fill=(235, 235, 235))
    return sheet
