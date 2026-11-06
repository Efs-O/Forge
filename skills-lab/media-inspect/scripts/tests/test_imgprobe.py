"""Still-image measurement and PNG metadata tests."""

import os
import sys
import tempfile
import unittest
import contextlib
import io
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import imgprobe  # noqa: E402

FIXTURES = Path(os.environ["MEDIA_INSPECT_FIXTURES"])


class ImgprobeTests(unittest.TestCase):
    def test_color_self_distance_is_zero_and_near(self):
        args = imgprobe._parser().parse_args([
            "color", str(FIXTURES / "a.png"), "--box", "0.25,0.4,0.75,0.6",
            "--reference", str(FIXTURES / "a.png"),
        ])
        result = imgprobe._measure(args)
        self.assertAlmostEqual(result["distance"], 0.0, places=9)
        self.assertEqual(result["verdict"], "near")

    def test_black_compare_counts_line_delta_in_percentage_points(self):
        args = imgprobe._parser().parse_args([
            "black", str(FIXTURES / "a.png"), "--compare", str(FIXTURES / "b.png"),
            "--box", "0.25,0.4,0.75,0.6",
        ])
        result = imgprobe._measure(args)
        self.assertAlmostEqual(result["worst_compare_delta_pp"], 10.0, places=6)
        self.assertGreater(result["worst_compare_delta_pp"], result["delta_threshold_pp"])

    def test_diff_self_is_zero_and_fixture_edit_is_nonzero(self):
        from PIL import Image
        from mediakit import mad

        first = Image.open(FIXTURES / "a.png").convert("RGB")
        changed = Image.open(FIXTURES / "b.png").convert("RGB")
        self.assertEqual(mad(first, first), 0.0)
        self.assertGreater(mad(first, changed), 0.0)

    def test_png_text_chunk_round_trips_and_dump_never_overwrites(self):
        from PIL import Image, PngImagePlugin

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            png = root / "with-text.png"
            info = PngImagePlugin.PngInfo()
            info.add_text("Comment", "sample metadata stays intact")
            Image.new("RGB", (8, 8), (20, 30, 40)).save(png, pnginfo=info)
            show = imgprobe._parser().parse_args(["meta", "show", str(png)])
            chunk = imgprobe._measure(show)["chunks"][0]
            self.assertEqual((chunk["key"], chunk["text"]), ("Comment", "sample metadata stays intact"))
            dump = imgprobe._parser().parse_args(["meta", "dump", str(root), "--out", str(root / "out")])
            result = imgprobe._measure(dump)
            self.assertEqual(len(result["files"]), 1)
            self.assertEqual(Path(result["files"][0]["path"]).read_text(encoding="utf-8"), chunk["text"])
            with self.assertRaises(ValueError):
                imgprobe._measure(dump)

    def test_corrupt_ztxt_returns_clean_error(self):
        import zlib

        def chunk(kind, data):
            return (struct.pack(">I", len(data)) + kind + data
                    + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff))

        with tempfile.TemporaryDirectory() as temp:
            png = Path(temp) / "bad-text.png"
            png.write_bytes(
                b"\x89PNG\r\n\x1a\n"
                + chunk(b"zTXt", b"Comment\0\0not a zlib stream")
                + chunk(b"IEND", b"")
            )
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                status = imgprobe.main(["meta", "show", str(png)])
            self.assertEqual(status, 4)
            self.assertEqual(stderr.getvalue().strip(), f"corrupt compressed text chunk in {png}")


if __name__ == "__main__":
    unittest.main()
