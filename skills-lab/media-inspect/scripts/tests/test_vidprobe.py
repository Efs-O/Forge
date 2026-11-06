import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
FIXTURES = Path(os.environ["MEDIA_INSPECT_FIXTURES"])
CLI = ROOT / "vidprobe.py"


def run_cli(*arguments):
    """Run the CLI and return (exit code, stdout, stderr) without raising."""
    result = subprocess.run(
        [sys.executable, "-B", str(CLI), *[str(item) for item in arguments]],
        capture_output=True, text=True, check=False,
    )
    return result.returncode, result.stdout, result.stderr


def run_json(*arguments):
    """Run the CLI with --json and return the parsed object, or fail on a bad exit code."""
    code, out, err = run_cli(*arguments, "--json")
    assert code == 0, f"exit {code}: {err}"
    return json.loads(out)


class VidprobeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.work = Path(tempfile.mkdtemp(prefix="vidprobe-test-"))
        cls.quiet = cls.work / "beep_quiet.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(FIXTURES / "beep.mp4"),
             "-af", "volume=0.5", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
             str(cls.quiet)],
            check=True, capture_output=True, text=True,
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.work, ignore_errors=True)

    def test_probe_reports_canvas_fps_and_frames(self):
        code, out, err = run_cli(FIXTURES / "box.mp4", "probe")
        self.assertEqual(code, 0, err)
        self.assertIn("canvas: 320x240", out)
        self.assertIn("fps: 24.000 (24/1)", out)
        self.assertIn("frames: 96", out)
        self.assertIn("audio: no", out)
        payload = run_json(FIXTURES / "box.mp4", "probe")
        self.assertEqual(payload["canvas"], [320, 240])
        self.assertEqual(Fraction(payload["fps_fraction"]), Fraction(24, 1))
        self.assertEqual(payload["frames"], 96)
        self.assertFalse(payload["has_audio"])
        self.assertTrue(run_json(FIXTURES / "beep.mp4", "probe")["has_audio"])

    def test_stats_motion_on_a_static_clip_is_near_zero(self):
        payload = run_json(FIXTURES / "still.mp4", "stats")
        self.assertLess(payload["motion"]["max"], 0.5, payload["motion"])
        code, out, err = run_cli(FIXTURES / "still.mp4", "stats")
        self.assertEqual(code, 0, err)
        self.assertIn("audio: none in this clip", out)

    def test_stats_reports_audio_mean_and_peak_db(self):
        payload = run_json(FIXTURES / "beep.mp4", "stats")
        self.assertGreater(payload["audio"]["peak_db"], -20.0, payload["audio"])
        self.assertGreater(payload["audio"]["mean_db"], -40.0, payload["audio"])
        code, out, err = run_cli(FIXTURES / "beep.mp4", "stats")
        self.assertRegex(out, r"audio: mean -?\d+\.\d dB  peak -?\d+\.\d dB")

    def test_frames_writes_one_row_per_frame(self):
        out_path = self.work / "rows.tsv"
        code, out, err = run_cli(FIXTURES / "box.mp4", "frames", "--out", out_path)
        self.assertEqual(code, 0, err)
        self.assertIn("96 rows, one per frame", out)
        rows = [line for line in out_path.read_text(encoding="utf-8").splitlines()
                if line and not line.startswith("#")]
        self.assertEqual(len(rows), 96, "the TSV must hold one row per frame")
        first = rows[0].split("\t")
        self.assertEqual(first[0], "0")
        self.assertEqual(first[1], "0.000")
        self.assertEqual(len(rows[95].split("\t")), 3)
        self.assertIn("threshold: 1.662 (mean 0.756 x factor 2.20)", out)
        self.assertIn("flagged: none above 1.662", out)

    def test_frames_flags_runs_of_two_or_more(self):
        out_path = self.work / "flagged.tsv"
        code, out, err = run_cli(FIXTURES / "box.mp4", "frames", "--out", out_path,
                                 "--factor", "1.2", "--json")
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["rows"], 96)
        self.assertGreater(payload["flagged_count"], 0, payload["threshold"])
        self.assertLessEqual(len(payload["top"]), 20)
        self.assertTrue(payload["runs"], "the moving square should produce runs")
        for run in payload["runs"]:
            self.assertGreaterEqual(run["frames"], 2, run)
            self.assertGreater(run["peak"], payload["threshold"], run)
        self.assertEqual(len(payload["runs"]), 8, "one run per traversal of the box")

    def test_region_reports_where_the_motion_is(self):
        payload = run_json(FIXTURES / "box.mp4", "region", "--box", "0.5,0,1,1")
        self.assertEqual(payload["box"], [160, 0, 320, 240])
        self.assertGreater(payload["ratio"], 1.3, payload)
        self.assertEqual(payload["verdict"], "WHERE")
        code, out, err = run_cli(FIXTURES / "box.mp4", "region", "--box", "0.5,0,1,1")
        self.assertRegex(out, r"WHERE region \(ratio \d+\.\d\d > 1\.30\)")

    def test_region_reports_a_static_box_is_not_where_the_motion_is(self):
        payload = run_json(FIXTURES / "box.mp4", "region", "--box", "0,0,0.5,1")
        self.assertLess(payload["ratio"], 1.0, payload)
        self.assertEqual(payload["verdict"], "NOT WHERE")

    def test_cycle_finds_the_repeat_period_of_the_moving_half(self):
        payload = run_json(FIXTURES / "box.mp4", "cycle", "--box", "0.5,0,1,1")
        self.assertEqual(len(payload["candidates"]), 3, payload["candidates"])
        best = payload["candidates"][0]
        self.assertIn(best["lag"], list(range(11, 14)) + list(range(23, 26)),
                      "the box moves back and forth, so the period is 24 frames "
                      "or its 12-frame half period")
        self.assertGreater(best["r"], 0.4, best)
        self.assertEqual(best["lag"], payload["best_lag"])
        code, out, err = run_cli(FIXTURES / "box.mp4", "cycle", "--box", "0.5,0,1,1")
        self.assertIn("cycle: period", out)
        self.assertIn("> 0.40", out)

    def test_cycle_prints_none_above_the_threshold_for_a_static_box(self):
        code, out, err = run_cli(FIXTURES / "box.mp4", "cycle", "--box", "0,0,0.5,1")
        self.assertEqual(code, 0, err)
        self.assertIn("cycles: none above r 0.40; best r", out)
        self.assertIn("at lag 12", out)

    def test_sync_reports_the_sound_as_late_by_three_frames(self):
        payload = run_json(FIXTURES / "beep.mp4", "sync")
        self.assertEqual(payload["motion_onsets"], 8, payload)
        self.assertEqual(payload["audio_onsets"], 8, payload)
        self.assertIn(payload["lag_frames"], (2, 3, 4), "the tone starts 3 frames after "
                        "each reversal; the motion signal first registers one frame later")
        self.assertAlmostEqual(payload["lag_ms"],
                               payload["lag_frames"] / 24.0 * 1000.0, places=1)
        self.assertGreater(payload["best_r"], 0.2, payload)
        code, out, err = run_cli(FIXTURES / "beep.mp4", "sync")
        self.assertIn("sound late by", out)
        self.assertIn("motion onsets: 8 (floor", out)
        self.assertIn("audio onsets: 8 (floor", out)

    def test_sync_says_so_for_a_clip_without_audio(self):
        code, out, err = run_cli(FIXTURES / "box.mp4", "sync")
        self.assertEqual(code, 0, err)
        self.assertIn("no audio track", out)

    def test_audio_peak_is_above_minus_twenty_dbfs(self):
        payload = run_json(FIXTURES / "beep.mp4", "audio")
        self.assertGreater(payload["peak_dbfs"], -20.0, payload)
        self.assertLess(payload["rms_dbfs"], payload["peak_dbfs"], payload)
        self.assertEqual(len(payload["fifths"]), 5)
        code, out, err = run_cli(FIXTURES / "beep.mp4", "audio")
        self.assertEqual(code, 0, err)
        lines = [line for line in out.splitlines() if "fifth " in line]
        self.assertEqual(len(lines), 5, out)
        values = [float(line.split()[-2]) for line in lines]
        self.assertEqual(values, sorted(values, reverse=True),
                         "the fifths should be printed loudest first")
        loudest = max(fifth["rms_dbfs"] for fifth in payload["fifths"])
        self.assertAlmostEqual(values[0], loudest, places=1)

    def test_audio_says_so_for_a_clip_without_audio(self):
        code, out, err = run_cli(FIXTURES / "box.mp4", "audio")
        self.assertEqual(code, 0, err)
        self.assertIn("audio: none in this clip", out)

    def test_loudness_compare_reports_a_signed_six_db_difference(self):
        payload = run_json(FIXTURES / "beep.mp4", "loudness", "--compare", self.quiet)
        difference = payload["compare"][0]["difference_db"]
        self.assertAlmostEqual(difference, -6.0, delta=0.3, msg=payload)
        code, out, err = run_cli(FIXTURES / "beep.mp4", "loudness", "--compare", self.quiet)
        self.assertEqual(code, 0, err)
        self.assertIn("difference: -6.0 dB quieter", out)

    def test_loudness_says_so_for_a_clip_without_audio(self):
        code, out, err = run_cli(FIXTURES / "still.mp4", "loudness",
                                 "--compare", FIXTURES / "beep.mp4")
        self.assertEqual(code, 0, err)
        self.assertIn("audio: none in this clip", out)
        self.assertIn("not comparable", out)

    def test_seam_first_against_last_on_a_static_clip_is_below_one(self):
        payload = run_json(FIXTURES / "still.mp4", "seam")
        self.assertLess(payload["first_last"], 1.0, payload)
        self.assertEqual(payload["first_frame"], 0)
        self.assertEqual(payload["last_frame"], 47)

    def test_seam_floor_measures_after_a_crf10_reencode(self):
        payload = run_json(FIXTURES / "box.mp4", "seam", "--floor")
        self.assertEqual(payload["floor_crf"], 10)
        self.assertIsNotNone(payload["floor"]["first_last"], payload)
        self.assertGreaterEqual(payload["floor"]["first_last"], 0.0)
        code, out, err = run_cli(FIXTURES / "still.mp4", "seam", "--floor")
        self.assertEqual(code, 0, err)
        floor_line = [line for line in out.splitlines() if line.startswith("floor (")]
        self.assertEqual(len(floor_line), 1, out)
        self.assertLess(float(floor_line[0].rsplit(" ", 1)[1]), 1.0, out)

    def test_seam_compares_against_a_given_still(self):
        payload = run_json(FIXTURES / "beep.mp4", "seam", "--first", FIXTURES / "a.png")
        self.assertIsNotNone(payload["first_image"])
        self.assertGreater(payload["first_image"], 0.0, "the grey clip frame is not the grey still")
        code, out, err = run_cli(FIXTURES / "beep.mp4", "seam", "--first", FIXTURES / "a.png")
        self.assertIn("--first image vs frame 0:", out)

    def test_unreadable_input_exits_four(self):
        code, out, err = run_cli(self.work / "missing.mp4", "probe")
        self.assertEqual(code, 4)
        self.assertIn("cannot read", err)

    def test_bad_box_exits_two(self):
        code, out, err = run_cli(FIXTURES / "box.mp4", "region", "--box", "0.5,10,0.9,20")
        self.assertEqual(code, 2)
        self.assertIn("bad --box", err)

    def test_missing_required_argument_exits_two(self):
        code, out, err = run_cli(FIXTURES / "box.mp4", "frames")
        self.assertEqual(code, 2)
        self.assertIn("--out", err)

    def test_unknown_subcommand_exits_two(self):
        code, out, err = run_cli(FIXTURES / "box.mp4", "guess")
        self.assertEqual(code, 2)
        self.assertIn("unknown subcommand", err)

    def test_json_mode_prints_one_object(self):
        payload = run_json(FIXTURES / "beep.mp4", "sync")
        self.assertEqual(
            sorted(payload),
            ["audio_onsets", "best_r", "box", "candidates", "corr", "floor_share",
             "lag_frames", "lag_ms", "max_lag_frames", "motion_onsets", "verdict"],
        )
        self.assertEqual(len(payload["candidates"]), 8, "--top 8 by default")


if __name__ == "__main__":
    unittest.main()
