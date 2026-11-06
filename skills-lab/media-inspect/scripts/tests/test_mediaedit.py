"""Verified video concatenation and narrow-line repair tests."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import mediaedit  # noqa: E402

FIXTURES = Path(os.environ["MEDIA_INSPECT_FIXTURES"])


class MediaeditTests(unittest.TestCase):
    def test_stitch_repeats_video_and_returns_audio_track(self):
        from mediakit import probe

        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "joined.mp4"
            args = mediaedit._parser().parse_args([
                "stitch", "--out", str(out), "--min-bytes", "1000",
                str(FIXTURES / "box.mp4"), str(FIXTURES / "box.mp4"),
            ])
            result = mediaedit._stitch(args)
            measured = probe(out)
            self.assertEqual(result["frames"], 192)
            self.assertEqual(measured.frames, 192)
            self.assertTrue(measured.has_audio)
            self.assertFalse(Path(temp, "joined.part.mp4").exists())

    def test_thinlines_repairs_line_keeps_wide_square_and_preserves_outside(self):
        import numpy as np
        from PIL import Image
        from mediakit import mad

        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "repaired.png"
            args = mediaedit._parser().parse_args([
                "thinlines", "--in", str(FIXTURES / "b.png"), "--out", str(out),
                "--box", "0.25,0.4,0.75,0.6", "--axis", "cols",
            ])
            result = mediaedit._thinlines(args)
            with Image.open(FIXTURES / "b.png") as original_file, Image.open(out) as output_file:
                original = original_file.convert("RGB")
                output = output_file.convert("RGB")
            reference = Image.open(FIXTURES / "a.png").convert("RGB")
            box = (50, 80, 150, 120)
            before = mad(original.crop(box), reference.crop(box))
            after = mad(output.crop(box), reference.crop(box))
            self.assertLess(after, before / 2)
            self.assertGreater(result["runs_seen"], 0)
            self.assertGreater(result["painted_pixels"], 0)
            outside = np.ones((original.height, original.width), dtype=bool)
            outside[box[1]:box[3], box[0]:box[2]] = False
            self.assertTrue(np.array_equal(np.asarray(output)[outside], np.asarray(original)[outside]))
            self.assertEqual(output.getpixel((20, 20)), original.getpixel((20, 20)))
            self.assertEqual(output.getpixel((75, 101)), (190, 190, 190))
            self.assertEqual(output.getpixel((75, 103)), (190, 190, 190))
            self.assertEqual(result["mad_vs_input"], mad(output.crop(box), original.crop(box)))
            square = (10, 10, 70, 70)
            self.assertTrue(np.array_equal(
                np.asarray(output.crop(square)), np.asarray(original.crop(square)),
            ))
            dilated = Image.new("L", original.size, 0)
            from PIL import ImageDraw
            ImageDraw.Draw(dilated).rectangle((48, 98, 151, 105), fill=255)
            outside_dilated = np.asarray(dilated) == 0
            self.assertTrue(np.array_equal(
                np.asarray(output)[outside_dilated], np.asarray(original)[outside_dilated],
            ))

    def test_thinlines_default_rows_repairs_transposed_vertical_line(self):
        from PIL import Image
        from mediakit import mad

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            transposed_b, transposed_a = root / "b.png", root / "a.png"
            for source, target in (("b.png", transposed_b), ("a.png", transposed_a)):
                with Image.open(FIXTURES / source) as image:
                    image.transpose(Image.Transpose.TRANSPOSE).save(target)
            out = root / "repaired.png"
            args = mediaedit._parser().parse_args([
                "thinlines", "--in", str(transposed_b), "--out", str(out),
                "--box", "80,50,120,150",
            ])
            self.assertEqual(args.axis, "rows")
            result = mediaedit._thinlines(args)
            with Image.open(out) as output_file:
                output = output_file.convert("RGB")
            with Image.open(transposed_b) as source_file, Image.open(transposed_a) as reference_file:
                source, reference = source_file.convert("RGB"), reference_file.convert("RGB")
            box = (80, 50, 120, 150)
            self.assertLess(mad(output.crop(box), reference.crop(box)), mad(source.crop(box), reference.crop(box)) / 2)
            self.assertGreater(result["painted_pixels"], 0)

    def test_thinlines_rows_does_not_paint_horizontal_line(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "unchanged.png"
            args = mediaedit._parser().parse_args([
                "thinlines", "--in", str(FIXTURES / "b.png"), "--out", str(out),
                "--box", "0.25,0.4,0.75,0.6", "--axis", "rows",
            ])
            result = mediaedit._thinlines(args)
            self.assertEqual(result["painted_pixels"], 0)


if __name__ == "__main__":
    unittest.main()
