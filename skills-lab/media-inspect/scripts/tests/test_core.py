import os
import subprocess
import sys
import unittest
from fractions import Fraction
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from mediakit import (  # noqa: E402
    audio_mono, autocorr_candidates, grab_frames, mad, parse_box, probe, ydif_series,
)
from mediakit.core import _fraction  # noqa: E402


FIXTURES = Path(os.environ["MEDIA_INSPECT_FIXTURES"])


class MediaKitCoreTests(unittest.TestCase):
    def test_parse_box_fraction_pixels_mixed_and_clamp(self):
        self.assertEqual(parse_box("0.25,0.4,0.75,0.6", 200, 100), (50, 40, 150, 60))
        self.assertEqual(parse_box("10,20,190,90", 200, 100), (10, 20, 190, 90))
        self.assertEqual(parse_box("-10,-5,210,105", 200, 100), (0, 0, 200, 100))
        with self.assertRaises(ValueError):
            parse_box("0.5,10,0.9,20", 200, 100)

    def test_probe_parses_fractional_frame_rate(self):
        self.assertEqual(probe(FIXTURES / "box.mp4").fps, Fraction(24, 1))
        self.assertEqual(_fraction("30000/1001"), Fraction(30000, 1001))

    def test_ydif_length_and_square_period(self):
        info = probe(FIXTURES / "box.mp4")
        motion = ydif_series(FIXTURES / "box.mp4")
        self.assertEqual(len(motion), info.frames)
        candidates = autocorr_candidates(motion[1:], min_period=10, top=3)
        self.assertTrue(candidates)
        self.assertLessEqual(abs(candidates[0][0] - 24), 1, candidates)
        self.assertGreater(candidates[0][1], 0.4, candidates)

    def test_ydif_box_measures_only_the_cropped_region(self):
        clip = FIXTURES / "box.mp4"
        left = ydif_series(clip, "0,0,0.5,1")
        right = ydif_series(clip, "0.5,0,1,1")
        self.assertLess(float(np.mean(left)), 0.5)
        self.assertGreater(float(np.mean(right)), 0.5)

    def test_cli_reports_missing_numpy_with_exit_three(self):
        scripts = ROOT
        cli = scripts / "vidprobe.py"
        wrapper = (
            "import runpy, sys; "
            f"sys.path.insert(0, {str(scripts)!r}); "
            "sys.modules['numpy'] = None; "
            f"sys.argv = [{str(cli)!r}]; "
            f"runpy.run_path({str(cli)!r}, run_name='__main__')"
        )
        result = subprocess.run(
            [sys.executable, "-c", wrapper], capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(
            result.stderr.strip(), "numpy is not installed: python -m pip install numpy",
        )

    def test_tile_scales_up_and_uses_scaled_cell_height(self):
        from mediakit import tile

        image = Image.new("RGB", (640, 360), (80, 100, 120))
        sheet = tile([(image, "one"), (image, "two")], cols=2, tile_w=320)
        self.assertEqual(sheet.size, (640, 180 + 22))

    def test_frame_decode_modes_match_requested_indices(self):
        stepped = grab_frames(FIXTURES / "box.mp4", step=8)
        exact = grab_frames(FIXTURES / "box.mp4", indices=stepped.keys(), exact=True)
        self.assertEqual(list(stepped), list(exact))
        self.assertEqual(set(stepped), set(range(0, 96, 8)))
        for index in stepped:
            self.assertEqual(mad(stepped[index], exact[index]), 0)

    def test_audio_lag_is_three_frames_125_ms(self):
        info = probe(FIXTURES / "beep.mp4")
        samples, rate = audio_mono(FIXTURES / "beep.mp4")
        self.assertGreater(rate, 0)
        frame_samples = round(rate / float(info.fps))
        energy = np.asarray([
            np.sqrt(np.mean(samples[i * frame_samples:(i + 1) * frame_samples] ** 2))
            for i in range(info.frames)
        ])
        onsets = [
            frame for frame in range(1, len(energy))
            if energy[frame] > 0.03 and energy[frame - 1] <= 0.03
        ]
        self.assertGreaterEqual(len(onsets), 6, onsets)
        self.assertTrue(all(frame % 12 == 3 for frame in onsets[:6]), onsets[:6])
        self.assertAlmostEqual(3 / float(info.fps), 0.125, places=6)

    def test_mad_self_is_zero(self):
        image = Image.new("RGB", (20, 20), (80, 100, 120))
        self.assertEqual(mad(image, image), 0)


if __name__ == "__main__":
    unittest.main()
