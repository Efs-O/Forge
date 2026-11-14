import re
import sys

TARGET = "3. `monitor_execution wait_ms: 90000"

for path in ("docs/CODING_TIPS.md", "resources/tips/CODING_TIPS.md"):
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().split("\n")
    start = lines.index("## RUN")
    end = next(i for i, l in enumerate(lines) if l.startswith("## ") and i > start)
    out, n, dropped = [], 0, 0
    for i, line in enumerate(lines):
        if start < i < end and re.match(r"^\d+\. ", line):
            if line.startswith(TARGET):
                dropped += 1
                continue
            n += 1
            line = re.sub(r"^\d+\. ", f"{n}. ", line)
        out.append(line)
    if dropped != 1:
        sys.exit(f"{path}: dropped {dropped} expected 1")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(out))
    print(f"{path}: dropped the line, RUN renumbered to {n} entries")
