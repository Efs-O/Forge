"""Grade a render by numbers, not by thumbnail. Runs INSIDE Blender.

    blender -b -P image_stats.py -- <png> [<png> ...]

For each image it prints mean / p50 / p95 and a clip count, measured from the
file's own pixels. A small image sent back through a chat lies about contrast;
these numbers do not, and they are comparable from one variant of a look to the
next. Luminance uses the Rec.709 weights (0.2126 / 0.7152 / 0.0722) on the
samples as the file stores them, so an sRGB PNG reports sRGB numbers.

Exit code is 1 when any file was missing or unreadable, so a caller can tell.
"""
import os
import sys

import bpy

CLIP_AT = 0.995


def measure(path):
    """Print the numbers for one image; return False when it could not be read."""
    img = bpy.data.images.load(path, check_existing=False)
    try:
        width, height = img.size[0], img.size[1]
        px = img.pixels[:]
    finally:
        bpy.data.images.remove(img)
    n = len(px) // 4
    if n == 0:
        print(f"STATS {os.path.basename(path)}: empty image")
        return False
    lum = [0.0] * n
    clipped = 0
    for i in range(n):
        k = 4 * i
        r, g, b = px[k], px[k + 1], px[k + 2]
        lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b
        if max(r, g, b) > CLIP_AT:
            clipped += 1
    lum.sort()
    mean = sum(lum) / n
    print(f"STATS {os.path.basename(path)} {width}x{height} "
          f"mean={mean:.4f} p50={lum[n // 2]:.3f} p95={lum[n * 19 // 20]:.3f} "
          f"clip>{CLIP_AT}={clipped} ({100.0 * clipped / n:.1f}%)")
    return True


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        print("usage: blender -b -P image_stats.py -- <png> [<png> ...]")
        return 1
    failed = []
    for arg in argv:
        # Blender resolves a relative path against its own folder, not the
        # shell's, so make every argument absolute before loading it.
        path = os.path.abspath(arg)
        if not os.path.exists(path):
            print(f"STATS {arg}: no such file")
            failed.append(path)
            continue
        try:
            if not measure(path):
                failed.append(path)
        except Exception as exc:  # a torn render must be loud, not silent
            print(f"STATS {path}: unreadable ({exc})")
            failed.append(path)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
