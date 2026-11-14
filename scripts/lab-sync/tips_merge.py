import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

FILES = ["docs/CODING_TIPS.md", "resources/tips/CODING_TIPS.md"]

MERGED_12 = (
    "a gated call batched with later gated calls → each raises its own card and waits the full "
    "`approval_timeout_minutes`; an expired card silences only that approval key"
)

for path in FILES:
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().split("\n")

    run_start = lines.index("## RUN")
    run_end = next(i for i, line in enumerate(lines) if i > run_start and line.startswith("## ") and line != "## RUN")

    changed = 0
    for i in range(run_start + 1, run_end):
        if lines[i].startswith("12. "):
            lines[i] = "12. " + MERGED_12
            changed += 1
        elif lines[i].startswith("13. expecting one approval"):
            lines[i] = ""
            changed += 1

    assert changed == 2, f"{path}: expected to touch RUN 12 and 13, touched {changed}"
    assert len("12. " + MERGED_12) <= 200, f"{path}: merged RUN 12 line is {len('12. ' + MERGED_12)} chars"

    # Re-number every section, then drop the one blank line left inside RUN.
    out = []
    number = 0
    in_section = False
    dropped_blank = False
    for i, line in enumerate(lines):
        if line.startswith("## "):
            in_section = True
            number = 0
            out.append(line)
            continue
        if (
            not dropped_blank
            and run_start < i < run_end
            and line == ""
        ):
            dropped_blank = True
            continue  # the blank left where RUN 13 was; the section separator stays
        match = re.match(r"^(\d+)\.\s(.*)$", line)
        if in_section and match:
            number += 1
            out.append(f"{number}. {match.group(2)}")
        else:
            out.append(line)

    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(out))

    body = [line for line in out if line != ""]
    print(path, "lines:", len(out), "numbered:", sum(1 for line in out if re.match(r"^\d+\. ", line)))

first = open(FILES[0], encoding="utf-8").read()
second = open(FILES[1], encoding="utf-8").read()
print("IDENTICAL" if first == second else "DIFFERENT")

for path in FILES:
    for line in open(path, encoding="utf-8"):
        if re.match(r"^\d+\. ", line) and len(line.rstrip("\n")) > 200:
            print("OVER 200:", path, line[:60])
