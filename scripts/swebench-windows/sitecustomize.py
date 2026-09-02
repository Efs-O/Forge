"""Keep SWE-bench shell scripts POSIX-compatible when launched on Windows."""

from pathlib import Path


def _write_text_lf(self, data, encoding=None, errors=None):
    with self.open(mode="w", encoding=encoding, errors=errors, newline="") as stream:
        return stream.write(data)


Path.write_text = _write_text_lf
