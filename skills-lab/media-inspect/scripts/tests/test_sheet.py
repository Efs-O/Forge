"""Tests for scripts/sheet.py: contact sheets, numbered image sets, region grids.

Fixtures are built by scripts/selftest.py's build_fixtures() into this test's own
temporary folder, so the tests never write into the shared fixture directory.
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import selftest  # noqa: E402
from PIL import Image  # noqa: E402


SHEET = ROOT / "sheet.py"
PYTHON = sys.executable
SIZE = re.compile(r"(\d+)x(\d+)px")
MANIFEST_ROW = re.compile(r"^\| (\d+) \| (.+) \| $")


class SheetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="sheet-test-"))
        cls.FIXTURES = selftest.build_fixtures(cls.tmp)
        cls.out = cls.tmp / "out"
        cls.out.mkdir()
        cls.extra = cls.tmp / "extra"
        cls.extra.mkdir()
        wide = Image.new("RGB", (400, 100), (10, 60, 120))
        wide.save(cls.extra / "wide.png")
        tall = Image.new("RGB", (100, 400), (10, 60, 120))
        tall.save(cls.extra / "tall.png")
        flat = Image.new("RGB", (160, 160), (180, 40, 40))
        flat.save(cls.extra / "flat.png")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ------------------------------------------------------------------ run --

    def run_sheet(self, *argv):
        return subprocess.run(
            [PYTHON, "-B", str(SHEET), *argv],
            capture_output=True, text=True, check=False,
        )

    def run_ok(self, *argv):
        result = self.run_sheet(*argv)
        self.assertEqual(result.returncode, 0, f"{argv}\n{result.stdout}\n{result.stderr}")
        return result

    def written_lines(self, stdout):
        return [line for line in stdout.splitlines() if line.startswith("wrote ")]

    def tiles_of(self, line):
        self.assertIn("tiles=", line, line)
        return int(line.rsplit("tiles=", 1)[1])

    def size_of(self, line):
        match = SIZE.search(line)
        self.assertIsNotNone(match, line)
        return tuple(int(value) for value in match.groups())

    def json_of(self, *argv):
        result = self.run_ok(*argv, "--json")
        lines = [line for line in result.stdout.splitlines() if line.strip()]
        self.assertEqual(len(lines), 1, f"--json must print one object: {result.stdout}")
        return json.loads(lines[0])

    def clip(self):
        return str(self.FIXTURES["box"])

    def image(self, name):
        return str(self.FIXTURES[name])

    def out_path(self, name):
        return str(self.out / name)

    # ------------------------------------------------------------ video mode --

    def test_video_step_writes_one_sheet_with_twelve_tiles(self):
        """The plan's test: box.mp4 --step 8 writes one PNG with 12 tiles."""
        target = self.out_path("step8.png")
        result = self.run_ok("video", self.clip(), "--step", "8", "--out", target)
        written = self.written_lines(result.stdout)
        self.assertEqual(len(written), 1, written)
        self.assertEqual(self.tiles_of(written[0]), 12, written[0])
        self.assertIn("12 tiles", result.stdout)
        self.assertIn(target, written[0], written[0])
        # 5 columns, 320 px wide tiles, 320x240 source, 22 px label rows:
        # 12 tiles -> ceil(12/5)=3 rows -> 3*(240+22) px tall.
        self.assertEqual(self.size_of(written[0]), (1600, 786), written[0])
        self.assertTrue(Path(target).exists())

    def test_video_count_spreads_frames_evenly_and_clamps_the_window(self):
        payload = self.json_of(
            "video", self.clip(), "--window", "1-9", "--count", "6",
            "--out", self.out_path("count.png"),
        )
        self.assertEqual(payload["tiles"], 6)
        self.assertEqual(payload["sampling"], {"count": 6})
        indices = payload["frame_indices"]
        self.assertEqual(len(indices), 6)
        self.assertEqual(indices[0], 24, indices)   # 1.0 s at 24 fps
        self.assertEqual(indices[-1], 95, indices)  # clamped to the last frame
        self.assertTrue(all(b > a for a, b in zip(indices, indices[1:])), indices)
        self.assertEqual(payload["window_s"], [1.0, 4.0], payload["window_s"])
        self.assertTrue(any("clamped to clip length" in note for note in payload["notes"]),
                        payload["notes"])

    def test_video_crop_twin_writes_a_crop_sheet_that_lines_up(self):
        target = self.out_path("twin.png")
        result = self.run_ok(
            "video", self.clip(), "--step", "12", "--crop-twin",
            "--box", "0.5,0,1,1", "--out", target,
        )
        written = self.written_lines(result.stdout)
        self.assertEqual(len(written), 2, written)
        self.assertEqual(self.tiles_of(written[0]), self.tiles_of(written[1]), written)
        twin = Path(self.out / "twin-crop.png")
        self.assertTrue(twin.exists(), "crop twin must sit next to the primary sheet")
        self.assertIn("twin-crop.png", written[1])
        self.assertIn("whole frame 0,0,320,240", result.stdout)
        self.assertIn("twin region: 160,0,320,240", result.stdout)
        self.assertEqual(len(list(self.out.glob("twin*"))), 2, "no temp files left behind")

    def test_video_zoom_shows_the_centre_of_the_box(self):
        result = self.run_ok(
            "video", self.clip(), "--step", "48", "--box", "0.5,0,1,1", "--zoom", "2",
            "--out", self.out_path("zoom.png"),
        )
        # Right half is 160,0,320,240; zoom 2 shows its centre half: 200,60,280,180.
        self.assertIn("primary region: 200,60,280,180 zoom 2", result.stdout)
        self.assertEqual(self.tiles_of(self.written_lines(result.stdout)[0]), 2)

    def test_video_exact_decodes_the_same_indices_as_one_pass(self):
        one_pass = self.json_of(
            "video", self.clip(), "--step", "16", "--out", self.out_path("one.png"),
        )
        exact = self.json_of(
            "video", self.clip(), "--step", "16", "--exact",
            "--out", self.out_path("exact.png"),
        )
        self.assertEqual(one_pass["frame_indices"], exact["frame_indices"])
        self.assertEqual(one_pass["frame_indices"], [0, 16, 32, 48, 64, 80])
        self.assertTrue(exact["exact"])

    def test_video_usage_errors_exit_two(self):
        for argv in (
            ("video", self.clip()),                                        # no --out
            ("video", self.clip(), "--out", self.out_path("w.png"), "--window", "5-1"),
            ("video", self.clip(), "--out", self.out_path("w.png"), "--step", "8", "--count", "6"),
            ("video", self.clip(), "--out", self.out_path("w.png"), "--step", "0"),
            ("video", self.clip(), "--crop-twin", "--out", self.out_path("w.png")),
        ):
            result = self.run_sheet(*argv)
            self.assertEqual(result.returncode, 2, f"{argv}\n{result.stderr}")

    def test_video_unreadable_input_exits_four(self):
        result = self.run_sheet("video", str(self.tmp / "missing.mp4"),
                                "--out", self.out_path("none.png"))
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn("input not found", result.stderr)

    # ----------------------------------------------------------- images mode --

    def test_images_three_files_give_one_sheet_and_a_three_row_manifest(self):
        """The plan's test: 3 images give 1 sheet; the manifest has 3 rows."""
        target = self.out_path("set.png")
        result = self.run_ok(
            "images", self.image("a"), self.image("b"), str(self.extra / "flat.png"),
            "--manifest", "--out", target,
        )
        written = self.written_lines(result.stdout)
        sheets = [line for line in written if "tiles=" in line]
        self.assertEqual(len(sheets), 1, written)
        self.assertEqual(self.tiles_of(sheets[0]), 3, sheets[0])
        # 5 columns of 340 px square cells, one row: 1700 x (340+22).
        self.assertEqual(self.size_of(sheets[0]), (1700, 362), sheets[0])
        manifest = self.out / "set-manifest.md"
        self.assertTrue(manifest.exists(), written)
        rows = [line for line in manifest.read_text(encoding="utf-8").splitlines()
                if MANIFEST_ROW.match(line + " ")]
        self.assertEqual(len(rows), 3, rows)
        numbers = [int(MANIFEST_ROW.match(line + " ").group(1)) for line in rows]
        self.assertEqual(numbers, [1, 2, 3], rows)
        for entry in (self.image("a"), self.image("b")):
            self.assertIn(Path(entry).name, "\n".join(rows), rows)

    def test_images_pages_over_one_sheet_and_continues_numbering(self):
        files = [self.image("a"), self.image("b")] * 6
        target = self.out_path("paged.png")
        result = self.run_ok(
            "images", *files, "--cols", "2", "--rows", "2", "--number-from", "13",
            "--manifest", "--out", target,
        )
        sheets = [line for line in self.written_lines(result.stdout) if "tiles=" in line]
        self.assertEqual(len(sheets), 3, sheets)
        self.assertEqual([self.tiles_of(line) for line in sheets], [4, 4, 4], sheets)
        for name in ("paged.png", "paged-2.png", "paged-3.png"):
            self.assertTrue((self.out / name).exists(), name)
        manifest = (self.out / "paged-manifest.md").read_text(encoding="utf-8").splitlines()
        numbers = [int(MANIFEST_ROW.match(line + " ").group(1))
                   for line in manifest if MANIFEST_ROW.match(line + " ")]
        self.assertEqual(numbers, list(range(13, 25)), numbers)

    def test_images_cells_are_square_even_for_mismatched_shapes(self):
        result = self.run_ok(
            "images", str(self.extra / "wide.png"), str(self.extra / "tall.png"),
            "--cols", "2", "--cell", "200", "--out", self.out_path("square.png"),
        )
        line = self.written_lines(result.stdout)[0]
        # 400x100 and 100x400 both letterbox into 200x200 cells.
        self.assertEqual(self.size_of(line), (400, 222), line)

    def test_images_order_file_drives_the_numbering(self):
        order = self.tmp / "order.txt"
        order.write_text(
            "# a comment\n"
            f"{(self.extra / 'flat.png').as_posix()}\n"
            f"{self.extra.name}/tall.png\n\n"
            f"{self.image('a')}\n",
            encoding="utf-8",
        )
        result = self.run_ok(
            "images", "--order-file", str(order), "--manifest",
            "--out", self.out_path("ordered.png"),
        )
        rows = [line for line in (self.out / "ordered-manifest.md").read_text(
            encoding="utf-8").splitlines() if MANIFEST_ROW.match(line + " ")]
        self.assertEqual(len(rows), 3, rows)
        names = [Path(MANIFEST_ROW.match(line + " ").group(2)).name for line in rows]
        self.assertEqual(names, ["flat.png", "tall.png", "a.png"], names)

    def test_images_usage_and_missing_input_errors(self):
        result = self.run_sheet("images", "--out", self.out_path("none.png"))
        self.assertEqual(result.returncode, 2, result.stderr)
        result = self.run_sheet("images", self.image("a"), str(self.tmp / "nope.png"),
                                "--out", self.out_path("none.png"))
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn("input not found", result.stderr)
        result = self.run_sheet("images", self.image("a"), "--order-file", str(self.tmp / "o.txt"),
                                "--out", self.out_path("none.png"))
        self.assertEqual(result.returncode, 2, result.stderr)

    # ------------------------------------------------------------- grid mode --

    def test_grid_preset_thirds_writes_three_sheets_of_three_tiles(self):
        """The plan's test: a.png --preset thirds writes 3 sheets of 3 tiles each."""
        result = self.run_ok("grid", self.image("a"), "--preset", "thirds",
                             "--out", str(self.out / "thirds"))
        sheets = [line for line in self.written_lines(result.stdout) if "tiles=" in line]
        self.assertEqual(len(sheets), 3, sheets)
        self.assertEqual([self.tiles_of(line) for line in sheets], [3, 3, 3], sheets)
        sizes = [self.size_of(line) for line in sheets]
        self.assertEqual(sizes[0], sizes[1], sheets)
        self.assertEqual(sizes[1], sizes[2], sheets)
        for page in (1, 2, 3):
            self.assertTrue((self.out / f"thirds-{page}.png").exists(), page)
        self.assertEqual(len(list(self.out.glob("thirds*"))), 3, "no temp files left behind")

    def test_grid_preset_halves_pages_four_regions(self):
        result = self.run_ok("grid", self.image("a"), "--preset", "halves",
                             "--out", str(self.out / "halves"))
        sheets = [line for line in self.written_lines(result.stdout) if "tiles=" in line]
        self.assertEqual(len(sheets), 2, sheets)
        self.assertEqual([self.tiles_of(line) for line in sheets], [3, 1], sheets)
        self.assertIn("halves_r1c1 0.0000,0.0000,0.5000,0.5000", result.stdout)

    def test_grid_region_file_and_custom_regions(self):
        region_file = self.tmp / "regions.json"
        region_file.write_text(
            json.dumps({"left": "0,0,0.5,1", "right": [0.5, 0, 1, 1]}), encoding="utf-8",
        )
        payload = self.json_of(
            "grid", self.image("a"), "--region-file", str(region_file),
            "--region", "middle:0.25,0.25,0.75,0.75", "--scale", "2",
            "--out", str(self.out / "named"),
        )
        names = [region["name"] for region in payload["regions"]]
        self.assertEqual(names, ["middle", "left", "right"], payload["regions"])
        self.assertEqual(payload["sheets"], 1, payload["regions"])
        self.assertEqual(payload["tile_w"], 200, payload)  # 100 px wide halves at scale 2

    def test_grid_region_file_flat_form(self):
        region_file = self.tmp / "regions.yaml"
        region_file.write_text(
            "# neutral geometry only\n"
            "top: 0,0,1,0.5\n"
            "bottom: 0.5,0,1,1\n",
            encoding="utf-8",
        )
        result = self.run_ok("grid", self.image("a"), "--region-file", str(region_file),
                             "--per-sheet", "2", "--out", str(self.out / "flat"))
        self.assertIn("2 region(s): top 0,0,1,0.5, bottom 0.5,0,1,1", result.stdout)
        sheets = [line for line in self.written_lines(result.stdout) if "tiles=" in line]
        self.assertEqual(len(sheets), 1, sheets)

    def test_grid_bands_compare_the_same_rows_across_images(self):
        result = self.run_ok(
            "grid", self.image("a"), self.image("b"), "--bands", "0.0-0.5,0.5-1.0",
            "--out", str(self.out / "bands"),
        )
        sheets = [line for line in self.written_lines(result.stdout) if "tiles=" in line]
        self.assertEqual(len(sheets), 2, sheets)
        self.assertEqual([self.tiles_of(line) for line in sheets], [2, 2], sheets)
        sizes = [self.size_of(line) for line in sheets]
        self.assertEqual(sizes, [(1200, 322), (1200, 322)], sheets)
        self.assertIn("overview skipped in band mode", result.stdout)

    def test_grid_overview_flag_adds_a_map_row(self):
        with_map = self.run_ok("grid", self.image("a"), "--preset", "center",
                               "--out", str(self.out / "map"))
        without = self.run_ok("grid", self.image("a"), "--preset", "center", "--overview", "0",
                              "--out", str(self.out / "nomap"))
        mapped = self.size_of(self.written_lines(with_map.stdout)[0])
        bare = self.size_of(self.written_lines(without.stdout)[0])
        # The map is the whole 200 px image (0.5 * 1600 capped to its own size)
        # plus its 22 px label row.
        self.assertEqual(mapped[0], bare[0], (mapped, bare))
        self.assertEqual(mapped[1] - bare[1], 222, (mapped, bare))

    def test_grid_usage_errors(self):
        for argv in (
            ("grid", self.image("a"), "--out", str(self.out / "none")),
            ("grid", self.image("a"), "--region", "novalue",
             "--out", str(self.out / "none")),
            ("grid", self.image("a"), "--preset", "thirds", "--bands", "0.0-0.5",
             "--out", str(self.out / "none")),
            ("grid", self.image("a"), "--region", "x:0,0,0.5,1", "--region", "x:0,0,1,0.5",
             "--out", str(self.out / "none")),
            ("grid", self.image("a"), "--overview", "2",
             "--out", str(self.out / "none")),
            ("grid", str(self.tmp / "nope.png"), "--preset", "center",
             "--out", str(self.out / "none")),
        ):
            result = self.run_sheet(*argv)
            expected = 4 if any("nope.png" in part for part in argv) else 2
            self.assertEqual(result.returncode, expected, f"{argv}\n{result.stderr}")


if __name__ == "__main__":
    unittest.main()
