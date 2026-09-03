"""Keep SWE-bench shell scripts POSIX-compatible when launched on Windows."""

from pathlib import Path


def _write_text_lf(self, data, encoding=None, errors=None):
    # Default to utf-8 so SWE-bench eval scripts (which contain non-ASCII)
    # don't crash on Windows boxes with a non-UTF-8 locale (e.g. cp1253).
    with self.open(mode="w", encoding=encoding or "utf-8", errors=errors, newline="") as stream:
        return stream.write(data)


Path.write_text = _write_text_lf
