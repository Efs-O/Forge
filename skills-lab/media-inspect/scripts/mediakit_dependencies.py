"""Standard-library-only checks used before importing optional media packages."""

from __future__ import annotations

import importlib
import shutil
import sys


def require(numpy: bool = True, pillow: bool = True, ffmpeg: bool = True) -> None:
    """Exit with status 3 and a plain install hint for missing dependencies."""
    for enabled, module, label, install in (
        (numpy, "numpy", "numpy", "python -m pip install numpy"),
        (pillow, "PIL.Image", "Pillow", "python -m pip install Pillow"),
    ):
        if enabled:
            try:
                importlib.import_module(module)
            except ImportError:
                print(f"{label} is not installed: {install}", file=sys.stderr)
                raise SystemExit(3) from None
    if ffmpeg and (shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None):
        print("ffmpeg/ffprobe is missing: install ffmpeg and add it to PATH", file=sys.stderr)
        raise SystemExit(3)
