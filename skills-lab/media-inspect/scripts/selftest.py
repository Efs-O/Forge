#!/usr/bin/env python3
"""Build deterministic media fixtures and run every available lane test."""

import sys
sys.dont_write_bytecode = True

import importlib.util
import os
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _ffmpeg(args: list[str]) -> None:
    import subprocess
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True)


def build_fixtures(dirpath: str | Path) -> dict[str, Path]:
    """Build synthetic video and image fixtures in dirpath and return their paths."""
    folder = Path(dirpath)
    folder.mkdir(parents=True, exist_ok=True)
    still = folder / "still.mp4"
    box = folder / "box.mp4"
    beep = folder / "beep.mp4"
    _ffmpeg([
        "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=24:d=2",
        "-frames:v", "48", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(still),
    ])
    _ffmpeg([
        "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=24:d=4",
        "-f", "lavfi", "-i", "color=c=white:s=40x40:r=24:d=4",
        "-filter_complex", "overlay=x=200+40*cos(2*PI*n/24):y=100:eval=frame",
        "-frames:v", "96", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(box),
    ])

    sample_rate = 48_000
    sample_count = 4 * sample_rate
    audio = np.zeros(sample_count, dtype=np.int16)
    tone_size = int(round(2 * sample_rate / 24))
    for start_frame in range(3, 96, 12):
        start = start_frame * sample_rate // 24
        end = min(sample_count, start + tone_size)
        times = np.arange(end - start, dtype=np.float64) / sample_rate
        audio[start:end] = np.round(0.5 * 32767 * np.sin(2 * np.pi * 1000 * times)).astype(np.int16)
    wav = folder / "beep.wav"
    with wave.open(str(wav), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(sample_rate)
        stream.writeframes(audio.tobytes())
    _ffmpeg([
        "-i", str(box), "-i", str(wav), "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", str(beep),
    ])
    a = Image.new("RGB", (200, 200), (190, 190, 190))
    b = a.copy()
    draw = ImageDraw.Draw(b)
    draw.rectangle((50, 100, 149, 103), fill=(0, 0, 0))
    draw.rectangle((10, 10, 69, 69), fill=(0, 0, 0))
    a_path, b_path = folder / "a.png", folder / "b.png"
    a.save(a_path)
    b.save(b_path)
    return {"still": still, "box": box, "beep": beep, "a": a_path, "b": b_path}


def _print_ground_truth(fixtures: dict[str, Path]) -> None:
    from mediakit import audio_mono, autocorr_candidates, frame_envelope, probe, ydif_series

    box_info = probe(fixtures["box"])
    candidates = autocorr_candidates(ydif_series(fixtures["box"])[1:], min_period=10, top=1)
    period, correlation = candidates[0]
    beep_info = probe(fixtures["beep"])
    samples, rate = audio_mono(fixtures["beep"])
    envelope = frame_envelope(samples, rate, beep_info.fps, beep_info.frames)
    onsets = [
        frame for frame in range(1, len(envelope))
        if envelope[frame] > 0.03 and envelope[frame - 1] <= 0.03
    ]
    if period != 24 or correlation <= 0.4 or not onsets:
        raise AssertionError(f"unexpected fixture measurements: period={candidates}, onsets={onsets}")
    lag = onsets[0] % 12
    print(f"ok ground truth: box period {period} frames (r {correlation:.3f})")
    print(f"ok ground truth: beep onset lag {lag} frames ({lag / float(beep_info.fps) * 1000:.1f} ms)")


def _load_test(path: Path) -> unittest.TestSuite:
    name = f"mediainspect_{path.stem}"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load test file: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return unittest.defaultTestLoader.loadTestsFromModule(module)


def main() -> int:
    try:
        with tempfile.TemporaryDirectory(prefix="media-inspect-") as temp:
            fixtures = build_fixtures(temp)
            _print_ground_truth(fixtures)
            os.environ["MEDIA_INSPECT_FIXTURES"] = temp
            test_files = sorted((ROOT / "tests").glob("test_*.py"))
            if not test_files:
                print("FAIL no scripts/tests/test_*.py files found")
                return 1
            failed = False
            for path in test_files:
                result = unittest.TextTestRunner(stream=open(os.devnull, "w"), verbosity=0).run(
                    _load_test(path)
                )
                if result.wasSuccessful():
                    print(f"ok {path.name} ({result.testsRun} tests)")
                else:
                    failed = True
                    print(f"FAIL {path.name} ({len(result.failures) + len(result.errors)} failures)")
                    for test, detail in [*result.failures, *result.errors]:
                        print(f"  {test}: {detail.splitlines()[-1] if detail else 'failed'}")
            return 1 if failed else 0
    except Exception as exc:
        print(f"FAIL fixture/self-test setup: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
