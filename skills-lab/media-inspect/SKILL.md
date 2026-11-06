---
name: media-inspect
description: Measure existing video clips and still images with reproducible local tools.
---

# Inspect existing media

This skill measures media files that already exist; it does not generate video or music. Use `generate_video` and `generate_music` when you need new media, and use this skill to inspect their outputs.

Python 3.10+, NumPy, Pillow, `ffmpeg`, and `ffprobe` must be available locally. Scripts do not make network requests. Outputs are written only to paths you provide, and temporary decode files are removed automatically.

| Tool | Use it for |
|---|---|
| `scripts/vidprobe.py` | Clip metadata, motion, frame changes, regions, cycles, audio, synchronization, and loop seams. See [vidprobe reference](references/vidprobe.md). |
| `scripts/sheet.py` | Contact sheets for sampled video frames, image collections, or named image regions. See [sheet reference](references/sheet.md). |
| `scripts/imgprobe.py` | Still-image colour, dark-pixel share, image differences, and PNG text metadata. See [imgprobe reference](references/imgprobe.md). |
| `scripts/mediaedit.py` | Verified clip stitching and constrained thin-line repair. See [mediaedit reference](references/mediaedit.md). |

Boxes use fractional coordinates from 0 to 1 by default. If any coordinate is greater than 1, all four coordinates are integer pixels. Video tools read frame rate from the input unless an explicit override is offered. Measurements are evidence for review, not pass/fail verdicts. Check each reference page for output fields, thresholds, and command examples.
