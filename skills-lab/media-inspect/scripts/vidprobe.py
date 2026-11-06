#!/usr/bin/env python3
"""Measure a clip's motion, audio and sound-to-motion timing without watching it."""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True   # a __pycache__ under a skill folder fails the VSIX content check

import argparse
import json
import math
import re
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

from mediakit_dependencies import require

try:                    # numpy and Pillow arrive together with the shared library
    import numpy as np
    from PIL import Image
    import mediakit
except ImportError:     # require() below names the missing package and exits 3
    np = None
    Image = None
    mediakit = None

EXIT_ARGS = 2
EXIT_MISSING_INPUT = 4

SUBCOMMANDS = (
    "probe", "stats", "frames", "region", "cycle", "sync", "audio", "loudness", "seam",
)

SUMMARY = {
    "probe": "canvas, fps, frames, duration, audio presence",
    "stats": "motion mean/median/p90/max, plus audio mean and peak dB",
    "frames": "every frame's motion value to a TSV, with flagged frames and runs",
    "region": "motion inside a box against the whole frame",
    "cycle": "the repeat period of the motion in a box",
    "sync": "sound-to-motion lag from an onset correlation scan",
    "audio": "peak and RMS in dBFS, and RMS per fifth of the clip",
    "loudness": "mean, peak and RMS level, with signed differences against other clips",
    "seam": "grayscale MAD of the first and last frames, and after a CRF 10 re-encode",
}

DESCRIPTION = (
    "Measure a video clip. These are instruments, not gates: a verdict never changes "
    "the exit code."
)
EPILOG = (
    "A --box is x0,y0,x1,y1 as a fraction of the canvas by default; any value above 1 "
    "switches all four to integer pixels.\n\n"
    "Exit codes: 0 measured, 2 bad arguments, 3 missing dependencies, 4 unreadable input.\n\n"
    "subcommands:\n" + "\n".join(f"  {name:8s} {text}" for name, text in SUMMARY.items())
)

_MEAN_VOLUME = re.compile(r"mean_volume:\s*(-?\d+(?:\.\d+)?) dB")
_MAX_VOLUME = re.compile(r"max_volume:\s*(-?\d+(?:\.\d+)?) dB")


def _round(value, digits=4):
    return round(float(value), digits)


def _volumedetect(clip: Path) -> tuple[float, float]:
    """Mean and peak level in dB, straight from ffmpeg's volumedetect filter."""
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(clip), "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, errors="replace",
    )
    mean, peak = _MEAN_VOLUME.search(result.stderr), _MAX_VOLUME.search(result.stderr)
    if not mean or not peak:
        raise RuntimeError("volumedetect reported no levels")
    return float(mean.group(1)), float(peak.group(1))


def _onsets(series: "np.ndarray", share: float) -> tuple[list[int], float, list[float]]:
    """Frames where a series rises to share x its own maximum after being below it.

    Each onset is weighted by the positive first difference of the log of the series at
    that frame, which is how strongly it stands out; a blip under the floor never counts.
    """
    values = np.asarray(series, dtype=np.float64)
    peak = float(values.max()) if values.size else 0.0
    if peak <= 0.0 or not 0 < share <= 1:
        return [], 0.0, []
    floor = share * peak
    log = np.log10(np.maximum(values, 1e-6))
    positive = np.maximum(np.diff(log, prepend=log[0]), 0.0)
    frames = [
        index for index in range(len(values))
        if values[index] >= floor and (index == 0 or values[index - 1] < floor)
    ]
    weights = [float(positive[index]) if index else float(log[index] + 6.0) for index in frames]
    return frames, floor, weights


def _indicator(length: int, frames: list[int], weights: list[float]) -> "np.ndarray":
    series = np.zeros(length, dtype=np.float64)
    for index, weight in zip(frames, weights):
        series[index] = weight
    return series


def _correlation_scan(motion: "np.ndarray", sound: "np.ndarray", max_lag: int) -> list[tuple[int, float]]:
    """Pearson r of the motion series against the sound series shifted by each lag.

    A positive lag means motion at frame f lines up with sound at frame f + lag,
    so the sound is that many frames late.
    """
    length = len(motion)
    out: list[tuple[int, float]] = []
    for lag in range(-max_lag, max_lag + 1):
        lo, hi = max(0, -lag), min(length, length - lag)
        if hi - lo < 2:
            continue
        left = motion[lo:hi]
        right = sound[lo + lag:hi + lag]
        left = left - left.mean()
        right = right - right.mean()
        denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
        out.append((lag, float(np.dot(left, right) / denominator) if denominator else 0.0))
    return sorted(out, key=lambda pair: pair[1], reverse=True)


def _time(seconds: float) -> str:
    return f"{seconds:.3f} s"


def _positive_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError("must be a positive number")
    return value


def _positive_int(text: str) -> int:
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return value


def _share(text: str) -> float:
    value = float(text)
    if not 0 < value <= 1:
        raise argparse.ArgumentTypeError("must be between 0 and 1")
    return value


def _frame_time(index: int, fps: Fraction) -> str:
    return f"frame {index} (t {index / float(fps):.3f} s)"


def cmd_probe(target: "Target", args: argparse.Namespace) -> tuple[list[str], dict]:
    info = target.info
    fps = target.fps
    fps_line = f"fps: {float(fps):.3f} ({fps.numerator}/{fps.denominator})"
    if args.fps:
        fps_line += f" (from --fps; the file says {float(info.fps):.3f})"
    lines = [
        f"canvas: {info.width}x{info.height}",
        fps_line,
        f"frames: {info.frames}",
        f"duration: {_time(info.duration)}",
        f"audio: {'yes' if info.has_audio else 'no'}",
    ]
    payload = {
        "canvas": [info.width, info.height],
        "fps": _round(float(fps)),
        "fps_fraction": f"{fps.numerator}/{fps.denominator}",
        "frames": info.frames,
        "duration": _round(info.duration, 3),
        "has_audio": info.has_audio,
    }
    return lines, payload


def cmd_stats(target: "Target", args: argparse.Namespace) -> tuple[list[str], dict]:
    motion = mediakit.ydif_series(target.path, target.box)
    measured = mediakit.stats(motion)
    lines = []
    if target.box_line:
        lines.append(target.box_line)
    lines.append(
        "motion: "
        f"mean {measured['mean']:.3f}  median {measured['median']:.3f}  "
        f"p90 {measured['p90']:.3f}  max {measured['max']:.3f} "
        f"(frame {measured['argmax']}, t {measured['argmax'] / float(target.fps):.3f} s)"
    )
    audio = None
    if target.info.has_audio:
        mean_db, peak_db = _volumedetect(target.path)
        lines.append(f"audio: mean {mean_db:.1f} dB  peak {peak_db:.1f} dB")
        audio = {"mean_db": _round(mean_db, 1), "peak_db": _round(peak_db, 1)}
    else:
        lines.append("audio: none in this clip")
    payload = {
        "box": list(target.box) if target.box else None,
        "motion": {key: _round(value) if key != "argmax" else int(value)
                   for key, value in measured.items()},
        "audio": audio,
    }
    return lines, payload


def cmd_frames(target: "Target", args: argparse.Namespace) -> tuple[list[str], dict]:
    motion = mediakit.ydif_series(target.path, target.box)
    threshold, flagged, runs = mediakit.flag_runs(motion, args.factor)
    mean = float(motion.mean())
    out = Path(args.out)
    header = (
        f"# frame\ttime_s\tmotion\t(one row per frame; threshold {threshold:.3f} "
        f"= mean {mean:.3f} x factor {args.factor:.2f})"
    )
    rows = [
        f"{index}\t{index / float(target.fps):.3f}\t{float(value):.3f}"
        for index, value in enumerate(motion)
    ]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join([header, *rows]) + "\n", encoding="utf-8")

    lines = [f"wrote: {out} ({len(rows)} rows, one per frame)"]
    if target.box_line:
        lines.append(target.box_line)
    lines.append(f"threshold: {threshold:.3f} (mean {mean:.3f} x factor {args.factor:.2f})")
    top = sorted(flagged, key=lambda index: -float(motion[index]))[:20]
    long_runs = [run for run in runs if run[1] - run[0] >= 1]
    if flagged:
        lines.append(f"flagged: {len(flagged)} frames above {threshold:.3f}")
        lines.append(f"top {len(top)} by value:")
        for index in top:
            lines.append(f"  {_frame_time(index, target.fps)}: {float(motion[index]):.3f}")
    else:
        peak = int(np.argmax(motion))
        lines.append(
            f"flagged: none above {threshold:.3f}; max {float(motion[peak]):.3f} "
            f"at frame {peak} (t {peak / float(target.fps):.3f} s)"
        )
    if long_runs:
        lines.append(f"runs of 2 or more: {len(long_runs)}")
        for start, end, peak in long_runs:
            lines.append(
                f"  frames {start}-{end}: {end - start + 1} frames, peak {peak:.3f}"
            )
    else:
        lines.append("runs: none of 2 or more")
    payload = {
        "out": str(out),
        "rows": len(rows),
        "box": list(target.box) if target.box else None,
        "factor": _round(args.factor, 2),
        "threshold": _round(threshold),
        "flagged_count": len(flagged),
        "top": [
            {"frame": index, "time_s": _round(index / float(target.fps), 3),
             "value": _round(motion[index])}
            for index in top
        ],
        "runs": [
            {"start": start, "end": end, "frames": end - start + 1, "peak": _round(peak)}
            for start, end, peak in long_runs
        ],
    }
    return lines, payload


def cmd_region(target: "Target", args: argparse.Namespace) -> tuple[list[str], dict]:
    inside = mediakit.ydif_series(target.path, target.box)
    whole = mediakit.ydif_series(target.path)
    region_mean = float(inside.mean())
    whole_mean = float(whole.mean())
    lines = []
    if target.box_line:
        lines.append(target.box_line)
    lines.append(f"region mean motion: {region_mean:.3f}")
    lines.append(f"whole mean motion: {whole_mean:.3f}")
    if whole_mean <= 1e-6:
        ratio = None
        verdict = (
            f"NOT WHERE: no motion anywhere (region {region_mean:.3f}, "
            f"whole {whole_mean:.3f}); ratio undefined"
        )
        kind = "NOT WHERE"
    else:
        ratio = region_mean / whole_mean
        if ratio > args.ratio:
            kind = "WHERE"
            verdict = f"WHERE region (ratio {ratio:.2f} > {args.ratio:.2f})"
        elif ratio < 1.0:
            kind = "NOT WHERE"
            verdict = f"NOT WHERE region (ratio {ratio:.2f} < 1.00; the box moves less than the whole frame)"
        else:
            kind = "NEUTRAL"
            verdict = f"NEUTRAL region (ratio {ratio:.2f} is between 1.00 and {args.ratio:.2f})"
    lines.append(verdict)
    payload = {
        "box": list(target.box) if target.box else None,
        "region_mean": _round(region_mean),
        "whole_mean": _round(whole_mean),
        "ratio": _round(ratio) if ratio is not None else None,
        "ratio_threshold": _round(args.ratio, 2),
        "verdict": kind,
        "line": verdict,
    }
    return lines, payload


def cmd_cycle(target: "Target", args: argparse.Namespace) -> tuple[list[str], dict]:
    series = mediakit.ydif_series(target.path, target.box)
    length = len(series)
    # The library's raw Pearson r favours a long lag because a long lag has less of
    # the clip left to disagree with, so each candidate is scored by how much of the
    # clip actually takes part in it.
    candidates = [
        (lag, r, r * math.sqrt((length - lag) / length))
        for lag, r in mediakit.autocorr_candidates(series, args.min_period, top=length)
    ]
    candidates.sort(key=lambda item: item[2], reverse=True)
    best = candidates[:3]
    lines = []
    if target.box_line:
        lines.append(target.box_line)
    lines.append(f"min period: {args.min_period} frames")
    for lag, r, score in best:
        lines.append(
            f"  lag {lag} frames ({lag / float(target.fps):.3f} s): "
            f"r {r:.3f} (score {score:.3f})"
        )
    if best:
        best_lag, best_r, best_score = best[0]
        if best_r > args.corr:
            verdict = (
                f"cycle: period {best_lag} frames "
                f"({best_lag / float(target.fps):.3f} s) at r {best_r:.3f} > {args.corr:.2f}"
            )
        else:
            verdict = (
                f"cycles: none above r {args.corr:.2f}; best r {best_r:.2f} at lag {best_lag}"
            )
    else:
        best_lag, best_r = None, None
        verdict = (
            f"cycles: none above r {args.corr:.2f}; no lag at or above {args.min_period} "
            f"frames to test in a {length}-frame clip"
        )
    lines.append(verdict)
    payload = {
        "box": list(target.box) if target.box else None,
        "min_period": args.min_period,
        "corr": _round(args.corr, 2),
        "candidates": [
            {"lag": lag, "r": _round(r), "score": _round(score)} for lag, r, score in best
        ],
        "best_lag": best_lag,
        "best_r": _round(best_r) if best_r is not None else None,
        "period_s": _round(best_lag / float(target.fps), 3) if best_lag else None,
        "verdict": verdict,
    }
    return lines, payload


def cmd_sync(target: "Target", args: argparse.Namespace) -> tuple[list[str], dict]:
    motion = mediakit.ydif_series(target.path, target.box)
    lines = []
    if target.box_line:
        lines.append(target.box_line)
    if not target.info.has_audio:
        lines.append("sync: this clip has no audio track, so there is nothing to correlate")
        payload = {
            "box": list(target.box) if target.box else None,
            "floor_share": _round(args.floor_share, 2),
            "motion_onsets": 0, "audio_onsets": 0, "max_lag_frames": 0, "corr": _round(args.corr, 2),
            "candidates": [], "lag_frames": None, "lag_ms": None, "best_r": None,
            "verdict": "no audio track",
        }
        return lines, payload
    samples, rate = mediakit.audio_mono(target.path)
    envelope = mediakit.frame_envelope(samples, rate, target.fps, len(motion))
    motion_frames, motion_floor, motion_weights = _onsets(motion, args.floor_share)
    sound_frames, sound_floor, sound_weights = _onsets(envelope, args.floor_share)
    motion_peak = float(np.max(motion)) if len(motion) else 0.0
    sound_peak = float(np.max(envelope)) if len(envelope) else 0.0
    lines.append(
        f"motion onsets: {len(motion_frames)} (floor {motion_floor:.3f} "
        f"= {args.floor_share:.2f} x max {motion_peak:.3f})"
    )
    lines.append(
        f"audio onsets: {len(sound_frames)} (floor {sound_floor:.4f} "
        f"= {args.floor_share:.2f} x max {sound_peak:.4f})"
    )
    max_lag = math.ceil(args.max_lag_ms / 1000.0 * float(target.fps))
    cap = max(1, len(motion) // 2)
    if max_lag > cap:
        lines.append(f"scan: --max-lag-ms {args.max_lag_ms} is longer than half the clip; "
                     f"capped at {cap} frames")
        max_lag = cap
    lines.append(
        f"scan: lag -{max_lag}..{max_lag} frames "
        f"(-{max_lag / float(target.fps) * 1000:.1f}..{max_lag / float(target.fps) * 1000:.1f} ms "
        f"at {float(target.fps):.3f} fps)"
    )
    payload: dict = {
        "box": list(target.box) if target.box else None,
        "floor_share": _round(args.floor_share, 2),
        "motion_onsets": len(motion_frames),
        "audio_onsets": len(sound_frames),
        "max_lag_frames": max_lag,
        "corr": _round(args.corr, 2),
        "candidates": [],
        "lag_frames": None,
        "lag_ms": None,
        "best_r": None,
        "verdict": "",
    }
    if not motion_frames or not sound_frames:
        lines.append(
            f"onsets: none to correlate (motion floor {motion_floor:.3f}, "
            f"audio floor {sound_floor:.4f}); no lag measured"
        )
        payload["verdict"] = "no onsets to correlate"
        return lines, payload
    scan = _correlation_scan(
        _indicator(len(motion), motion_frames, motion_weights),
        _indicator(len(motion), sound_frames, sound_weights),
        max_lag,
    )
    if not scan:
        lines.append("scan: no lag in range had two frames to compare; no lag measured")
        payload["verdict"] = "no lag in range to compare"
        return lines, payload
    best_lag, best_r = scan[0]
    ms = best_lag / float(target.fps) * 1000.0
    for lag, r in scan[:args.top]:
        lines.append(f"  lag {lag} ({lag / float(target.fps) * 1000.0:.1f} ms): r {r:.3f}")
    if best_r <= args.corr:
        verdict = (
            f"lag: none above r {args.corr:.2f}; best r {best_r:.3f} at lag {best_lag}. "
            "Do not read this as a lag."
        )
    elif best_lag == 0:
        verdict = (
            f"lag: {best_lag} frames at r {best_r:.3f} > {args.corr:.2f}; "
            "sound and motion onset together"
        )
    elif best_lag > 0:
        verdict = (
            f"lag: {best_lag} frames at r {best_r:.3f} > {args.corr:.2f}; "
            f"sound late by {best_lag} frames ({ms:.1f} ms)"
        )
    else:
        verdict = (
            f"lag: {best_lag} frames at r {best_r:.3f} > {args.corr:.2f}; "
            f"sound early by {-best_lag} frames ({-ms:.1f} ms)"
        )
    lines.append(verdict)
    payload["verdict"] = verdict
    payload["candidates"] = [
        {"lag": lag, "ms": _round(lag / float(target.fps) * 1000.0, 1), "r": _round(r)}
        for lag, r in scan[:args.top]
    ]
    payload["lag_frames"] = best_lag
    payload["lag_ms"] = _round(ms, 1)
    payload["best_r"] = _round(best_r)
    return lines, payload


def cmd_audio(target: "Target", args: argparse.Namespace) -> tuple[list[str], dict]:
    if not target.info.has_audio:
        return ["audio: none in this clip"], {
            "peak_dbfs": None, "rms_dbfs": None, "sample_rate": None,
            "samples": 0, "duration_s": None, "fifths": [],
        }
    samples, rate = mediakit.audio_mono(target.path)
    values = samples.astype(np.float64)
    peak = float(np.max(np.abs(values))) if values.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(values)))) if values.size else 0.0
    step = max(1, len(values) // 5)
    fifths = []
    for index in range(5):
        start = index * step
        chunk = values[start:start + step] if index < 4 else values[start:]
        chunk_rms = float(np.sqrt(np.mean(np.square(chunk)))) if chunk.size else 0.0
        fifths.append({
            "index": index + 1,
            "t0": _round(start / rate, 3),
            "t1": _round((start + len(chunk)) / rate, 3),
            "rms_dbfs": _round(mediakit.db(chunk_rms), 1),
        })
    lines = [
        f"peak: {mediakit.db(peak):.1f} dBFS",
        f"rms:  {mediakit.db(rms):.1f} dBFS",
        f"rate: {rate} Hz, {len(values)} samples, {_time(len(values) / rate)}",
        "fifths by rms (loudest first):",
    ]
    for fifth in sorted(fifths, key=lambda item: item["rms_dbfs"], reverse=True):
        lines.append(f"  fifth {fifth['index']} ({fifth['t0']:.3f}-{fifth['t1']:.3f} s): "
                     f"{fifth['rms_dbfs']:.1f} dBFS")
    return lines, {
        "peak_dbfs": _round(mediakit.db(peak), 1),
        "rms_dbfs": _round(mediakit.db(rms), 1),
        "sample_rate": rate,
        "samples": int(values.size),
        "duration_s": _round(len(values) / rate, 3),
        "fifths": fifths,
    }


def cmd_loudness(target: "Target", args: argparse.Namespace) -> tuple[list[str], dict]:
    def measure(clip: Path) -> dict:
        info = mediakit.probe(clip)
        if not info.has_audio:
            return {"clip": str(clip), "audio": None}
        mean_db, peak_db = _volumedetect(clip)
        samples, _rate = mediakit.audio_mono(clip)
        values = samples.astype(np.float64)
        rms = float(np.sqrt(np.mean(np.square(values)))) if values.size else 0.0
        return {
            "clip": str(clip),
            "audio": True,
            "mean_db": _round(mean_db, 1),
            "peak_db": _round(peak_db, 1),
            "rms_dbfs": _round(mediakit.db(rms), 1),
        }

    here = measure(target.path)
    lines = [f"clip: {here['clip']}"]
    if here["audio"] is None:
        lines.append("  audio: none in this clip")
    else:
        lines.append(
            f"  mean: {here['mean_db']:.1f} dB  peak: {here['peak_db']:.1f} dB  "
            f"rms: {here['rms_dbfs']:.1f} dBFS"
        )
    compared = []
    for other in args.compare:
        clip = Path(other)
        entry = measure(clip)
        lines.append(f"compare: {entry['clip']}")
        if entry["audio"] is None:
            lines.append("  audio: none in this clip")
            lines.append("  difference: not measurable (no audio to compare)")
        else:
            lines.append(
                f"  mean: {entry['mean_db']:.1f} dB  peak: {entry['peak_db']:.1f} dB  "
                f"rms: {entry['rms_dbfs']:.1f} dBFS"
            )
            if here["audio"] is None:
                lines.append("  difference: not comparable (this clip has no audio)")
            else:
                delta = entry["rms_dbfs"] - here["rms_dbfs"]
                word = "quieter" if delta < 0 else ("louder" if delta > 0 else "the same level")
                lines.append(f"  difference: {delta:+.1f} dB {word} (rms dBFS against this clip)")
                entry["difference_db"] = _round(delta, 2)
        compared.append(entry)
    payload = {
        "clip": here["clip"],
        "mean_db": here.get("mean_db"),
        "peak_db": here.get("peak_db"),
        "rms_dbfs": here.get("rms_dbfs"),
        "compare": compared,
    }
    return lines, payload


def _open_still(path: str | None) -> Image.Image | None:
    """Load a still as an RGB copy, closing the source handle before returning it."""
    if path is None:
        return None
    with Image.open(path) as image:
        return image.convert("RGB")


def cmd_seam(target: "Target", args: argparse.Namespace) -> tuple[list[str], dict]:
    last = target.info.frames - 1
    frames = mediakit.grab_frames(target.path, indices=[0, last])
    first_image = _open_still(args.first)
    last_image = _open_still(args.last)

    def pair_mad(reference: Image.Image, index: int) -> float:
        return mediakit.mad(reference, frames[index])

    direct = {
        "first_last": mediakit.mad(frames[0], frames[last]),
        "first_image": pair_mad(first_image, 0) if first_image is not None else None,
        "last_image": pair_mad(last_image, last) if last_image is not None else None,
    }
    lines = [f"first vs last: {direct['first_last']:.3f}"]
    if first_image is not None:
        lines.append(f"--first image vs frame 0: {direct['first_image']:.3f}")
    if last_image is not None:
        lines.append(f"--last image vs frame {last}: {direct['last_image']:.3f}")
    payload: dict = {
        "first_last": _round(direct["first_last"]),
        "first_image": _round(direct["first_image"]) if direct["first_image"] is not None else None,
        "last_image": _round(direct["last_image"]) if direct["last_image"] is not None else None,
        "first_frame": 0,
        "last_frame": last,
    }
    if args.floor:
        with tempfile.TemporaryDirectory(prefix="vidprobe-") as temp:
            reencoded = Path(temp) / "floor.mp4"
            encoded = subprocess.run(
                ["ffmpeg", "-hide_banner", "-y", "-v", "error", "-i", str(target.path),
                 "-an", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", str(reencoded)],
                capture_output=True, text=True, errors="replace",
            )
            if encoded.returncode != 0:
                detail = (encoded.stderr or "").strip().splitlines()
                raise RuntimeError(
                    "ffmpeg re-encode failed: "
                    + (detail[-1] if detail else f"exit {encoded.returncode}")
                )
            floor_info = mediakit.probe(reencoded)
            floor_last = floor_info.frames - 1
            floor_frames = mediakit.grab_frames(reencoded, indices=[0, floor_last])

            def floor_mad(reference: Image.Image, index: int) -> float:
                return mediakit.mad(reference, floor_frames[index])

            floored = {
                "first_last": mediakit.mad(floor_frames[0], floor_frames[floor_last]),
                "first_image": floor_mad(first_image, 0) if first_image is not None else None,
                "last_image": floor_mad(last_image, floor_last) if last_image is not None else None,
            }
        lines.append(
            f"floor (libx264 crf 10 re-encode, {floor_info.frames} frames): "
            f"first vs last {floored['first_last']:.3f}"
        )
        if first_image is not None:
            lines.append(f"floor --first image vs frame 0: {floored['first_image']:.3f}")
        if last_image is not None:
            lines.append(f"floor --last image vs frame {floor_last}: {floored['last_image']:.3f}")
        payload["floor"] = {
            key: _round(value) if value is not None else None for key, value in floored.items()
        }
        payload["floor_crf"] = 10
    return lines, payload


COMMANDS = {
    "probe": cmd_probe, "stats": cmd_stats, "frames": cmd_frames, "region": cmd_region,
    "cycle": cmd_cycle, "sync": cmd_sync, "audio": cmd_audio, "loudness": cmd_loudness,
    "seam": cmd_seam,
}


class Target:
    """The clip, its probe, the parsed box and the frame rate the run will use."""

    def __init__(self, path: Path, info, box, box_line: str | None, fps: Fraction):
        self.path = path
        self.info = info
        self.box = box
        self.box_line = box_line
        self.fps = fps


def _build_parser(subcommand: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=f"vidprobe.py <clip> {subcommand}",
        description=SUMMARY[subcommand],
        epilog="A --box is x0,y0,x1,y1 as a fraction of the canvas by default; "
               "any value above 1 switches all four to integer pixels.",
    )
    parser.add_argument("clip", help="clip to measure")
    if subcommand in ("probe", "frames", "sync", "audio"):
        parser.add_argument("--fps", help="override the frame rate read from the file "
                                          "(accepts 30 or 30000/1001)")
    if subcommand in ("stats", "frames", "region", "cycle", "sync"):
        box_help = "x0,y0,x1,y1; fractions of the canvas by default"
        if subcommand == "region":
            box_help += " (required)"
        parser.add_argument("--box", required=(subcommand == "region"), help=box_help)
    if subcommand == "frames":
        parser.add_argument("--out", required=True, help="TSV to write one row per frame")
        parser.add_argument("--factor", type=_positive_float, default=2.2,
                            help="flag frames above mean x this factor (2.2)")
    if subcommand == "region":
        parser.add_argument("--ratio", type=_positive_float, default=1.3,
                            help="WHERE threshold on region mean against whole mean (1.3)")
    if subcommand == "cycle":
        parser.add_argument("--min-period", type=_positive_int, default=12, dest="min_period",
                            help="shortest lag to test, in frames (12)")
        parser.add_argument("--corr", type=_positive_float, default=0.40,
                            help="period is accepted above this r (0.40)")
    if subcommand == "sync":
        parser.add_argument("--max-lag-ms", type=_positive_float, default=300.0, dest="max_lag_ms",
                            help="largest lag to scan, in milliseconds (300)")
        parser.add_argument("--top", type=_positive_int, default=8,
                            help="how many lag candidates to print (8)")
        parser.add_argument("--floor-share", type=_share, default=0.20, dest="floor_share",
                            help="onset floor as a share of each signal's own maximum (0.20)")
        parser.add_argument("--corr", type=_positive_float, default=0.20,
                            help="r above which the lag is reported as a lag (0.20)")
    if subcommand == "loudness":
        parser.add_argument("--compare", action="append", default=[], metavar="CLIP",
                            help="another clip to measure and diff against this one (repeatable)")
    if subcommand == "seam":
        parser.add_argument("--first", help="image to compare against frame 0")
        parser.add_argument("--last", help="image to compare against the last frame")
        parser.add_argument("--floor", action="store_true",
                            help="also measure the same pair after a libx264 crf 10 re-encode")
    parser.add_argument("--json", action="store_true",
                        help="print one JSON object instead of the text report")
    return parser


def main(argv=None):
    require()
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print("usage: vidprobe.py <clip> <subcommand> [flags]", file=sys.stderr)
        print(__doc__.strip(), file=sys.stderr)
        return EXIT_ARGS
    top = argparse.ArgumentParser(prog="vidprobe.py", description=DESCRIPTION, epilog=EPILOG)
    if any(flag in argv for flag in ("-h", "--help")) and (
        len(argv) < 2 or argv[1] not in COMMANDS
    ):
        top.print_help()
        return 0
    if len(argv) < 2:
        print(f"vidprobe.py: a subcommand is required: {', '.join(SUBCOMMANDS)}",
              file=sys.stderr)
        return EXIT_ARGS
    clip, subcommand = Path(argv[0]), argv[1]
    if subcommand not in COMMANDS:
        print(f"vidprobe.py: unknown subcommand '{subcommand}': "
              f"expected {', '.join(SUBCOMMANDS)}", file=sys.stderr)
        return EXIT_ARGS
    parser = _build_parser(subcommand)
    args = parser.parse_args([str(clip), *argv[2:]])
    try:
        info = mediakit.probe(args.clip)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"vidprobe.py: cannot read {args.clip}: {exc}", file=sys.stderr)
        return EXIT_MISSING_INPUT
    fps = info.fps
    if getattr(args, "fps", None):
        try:
            fps = Fraction(args.fps)
        except (ValueError, ZeroDivisionError):
            print(f"vidprobe.py: --fps is not a frame rate: {args.fps}", file=sys.stderr)
            return EXIT_ARGS
        if fps <= 0:
            print("vidprobe.py: --fps must be positive", file=sys.stderr)
            return EXIT_ARGS
    box, box_line = None, None
    if getattr(args, "box", None):
        try:
            box = mediakit.parse_box(args.box, info.width, info.height)
        except ValueError as exc:
            print(f"vidprobe.py: bad --box '{args.box}': {exc}", file=sys.stderr)
            return EXIT_ARGS
        box_line = f"box: {args.box} -> {box[0]},{box[1]},{box[2]},{box[3]} px"
    target = Target(Path(args.clip), info, box, box_line, fps)
    try:
        lines, payload = COMMANDS[subcommand](target, args)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"vidprobe.py: {exc}", file=sys.stderr)
        return EXIT_MISSING_INPUT
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
