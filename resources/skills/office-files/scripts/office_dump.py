"""Dump the text inside an Office file without opening it.

usage: python office_dump.py <file-or-glob> [...]

Prints, per paragraph: the text, how many runs it is split into, and every
non-ASCII character with its codepoint and name. Both matter: a line split into
many runs cannot be found by a string replace on the XML, and Greek files carry
Latin look-alikes (O Y K A I) that only the codepoint reveals.
"""

import sys
import glob
import zipfile
import unicodedata
from xml.etree import ElementTree as ET

sys.stdout.reconfigure(encoding="utf-8")

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
D = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

ZIP_KIND = {".docx", ".docm", ".pptx", ".xlsx", ".xlsm"}
OLD_KIND = {".doc", ".xls", ".ppt"}


def non_ascii(joined, indent="    "):
    seen = {}
    for ch in joined:
        if ord(ch) >= 128:
            seen.setdefault(ch, unicodedata.name(ch, "?"))
    for ch, name in seen.items():
        print("%s%s U+%04X %s" % (indent, ch, ord(ch), name))


def dump_docx(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    for i, p in enumerate(root.iter(W + "p")):
        runs = [t.text or "" for t in p.iter(W + "t")]
        joined = "".join(runs)
        print("PARA %d runs=%d %r" % (i, len(runs), joined))
        if len(runs) > 1:
            print("      as runs: %r" % (runs,))
        non_ascii(joined)


def dump_pptx(path):
    with zipfile.ZipFile(path) as z:
        slides = sorted(
            n
            for n in z.namelist()
            if n.startswith("ppt/slides/slide") and n.endswith(".xml")
        )
        for name in slides:
            print("SLIDE " + name)
            root = ET.fromstring(z.read(name))
            for p in root.iter(A + "p"):
                parts = []
                for node in p.iter():
                    tag = node.tag.split("}")[-1]
                    if tag == "t":
                        parts.append(node.text or "")
                    elif tag == "br":
                        parts.append("\n")
                joined = "".join(parts)
                print("  %r" % (joined,))
                non_ascii(joined, "      ")


def dump_xlsx(path):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if "xl/workbook.xml" in names:
            wb = ET.fromstring(z.read("xl/workbook.xml"))
            print("SHEETS: " + ", ".join(s.get("name", "?") for s in wb.iter(D + "sheet")))
        if "xl/sharedStrings.xml" in names:
            ss = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for i, si in enumerate(ss.iter(D + "si")):
                joined = "".join(t.text or "" for t in si.iter(D + "t"))
                print("STRING %d %r" % (i, joined))
                non_ascii(joined)
        else:
            print("(no sharedStrings.xml: inline strings, read the sheet parts)")


HANDLERS = {
    ".docx": dump_docx,
    ".docm": dump_docx,
    ".pptx": dump_pptx,
    ".xlsx": dump_xlsx,
    ".xlsm": dump_xlsx,
}


def main():
    if not sys.argv[1:]:
        print(__doc__)
        return 1
    found = []
    for arg in sys.argv[1:]:
        hits = glob.glob(arg)
        if not hits:
            print("NO MATCH " + arg)
        found.extend(hits)
    for path in found:
        low = path.lower()
        dot = low.rfind(".")
        ext = low[dot:] if dot > low.rfind("/") else ""
        print("=== " + path)
        if ext in HANDLERS:
            try:
                HANDLERS[ext](path)
            except Exception as exc:
                print("ERROR %r" % (exc,))
        elif ext in OLD_KIND:
            print("OLD BINARY FORMAT (%s): not a zip. open it in the app or convert it." % ext)
        else:
            print("not an Office file (%s)" % (ext or "no extension"))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
