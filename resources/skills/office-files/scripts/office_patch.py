"""Replace text inside a .docx by rewriting whole paragraphs — only when the app is CLOSED.

usage: python office_patch.py <file.docx> --replace "old" "new" [--replace ...] [--dry]

Word splits one visible line into many runs, so a string replace on the XML misses it.
This matches on a paragraph's joined text and rewrites it, which FLATTENS that
paragraph's run formatting into the first run's font — fine for a one-line notice,
wrong for a styled document (use the app's Find and Replace there).

Refuses while Word holds the document open (a ~$name.docx lock file sits next to it).
Always re-read the result with office_dump.py.
"""

import sys
import os
import re
import shutil
import zipfile
import tempfile
from xml.etree import ElementTree as ET

sys.stdout.reconfigure(encoding="utf-8")

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def register_namespaces(xml_bytes):
    """Keep the file's own prefixes so ElementTree does not emit ns0: tags."""
    for m in re.finditer(rb'xmlns:([A-Za-z0-9_]+)="([^"]+)"', xml_bytes):
        ET.register_namespace(m.group(1).decode(), m.group(2).decode())
    m = re.search(rb'xmlns="([^"]+)"', xml_bytes)
    if m:
        ET.register_namespace("", m.group(1).decode())


XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


def paragraph_runs(p):
    """The w:t of THIS paragraph only, in document order. A paragraph can hold a
    text box, whose nested w:p owns its own text: iterating recursively used to
    pull those runs in, which merged the two texts and emptied the box."""
    runs = []

    def walk(el):
        for child in el:
            if child.tag == W + "p":
                continue  # a nested paragraph owns its own text
            if child.tag == W + "t":
                runs.append(child)
            walk(child)

    walk(p)
    return runs


def patch_paragraphs(root, pairs):
    """Return (changed_paragraphs, changed_chars) after applying pairs everywhere."""
    changed = 0
    chars = 0
    for p in root.iter(W + "p"):
        runs = paragraph_runs(p)
        if not runs:
            continue
        joined = "".join(r.text or "" for r in runs)
        new = joined
        for old, repl in pairs:
            new = new.replace(old, repl)
        if new == joined:
            continue
        changed += 1
        chars += len(new) - len(joined)
        runs[0].text = new
        # Word trims a leading or trailing space unless the run says to keep it.
        if new[:1].isspace() or new[-1:].isspace():
            runs[0].set(XML_SPACE, "preserve")
        for extra in runs[1:]:
            extra.text = ""
    return changed, chars


def restore_root_tag(new_xml, raw):
    """Put the original root start tag back. ElementTree drops every namespace
    declaration no element actually uses, and Word declares most of its prefixes
    only inside `mc:Ignorable="w14 w15 wp14"` — a string attribute ET cannot see.
    Without them Word calls the file unreadable, so the patch must ship the tag
    the file came with."""
    old = re.search(rb"<[\w:]*document\b[^>]*>", raw)
    found = re.search(rb"<[\w:]*document\b[^>]*>", new_xml)
    if not old or not found:
        return new_xml
    return new_xml[: found.start()] + old.group(0) + new_xml[found.end() :]


def main():
    args = sys.argv[1:]
    dry = "--dry" in args
    pairs = []
    path = None
    i = 0
    while i < len(args):
        if args[i] == "--replace":
            pairs.append((args[i + 1], args[i + 2]))
            i += 3
        elif args[i] == "--dry":
            i += 1
        else:
            path = args[i]
            i += 1
    if not path or not pairs:
        print(__doc__)
        return 1
    if not path.lower().endswith((".docx", ".docm")):
        print("this patcher handles .docx only; dump other formats and edit them in the app")
        return 1

    base = os.path.dirname(os.path.abspath(path))
    name = os.path.basename(path)
    # Word writes its owner file as "~$" + the name with the first two characters
    # dropped ("BANK DETAILS.DOCX" -> "~$NK DETAILS.DOCX"), so check every shape.
    locks = [os.path.join(base, "~$" + cut) for cut in (name[2:], name[1:], name)]
    held = [l for l in locks if os.path.exists(l)]
    if held:
        print("REFUSED: %s looks open in Word (%s exists). Close it, or use Find and Replace."
              % (name, os.path.basename(held[0])))
        return 1

    with zipfile.ZipFile(path) as z:
        items = [
            (n, z.read(n), z.getinfo(n).compress_type, z.getinfo(n).date_time)
            for n in z.namelist()
        ]
    raw = dict((n, b) for n, b, _, _ in items)["word/document.xml"]
    register_namespaces(raw)
    root = ET.fromstring(raw)
    changed, chars = patch_paragraphs(root, pairs)
    print("paragraphs changed: %d  (net %d characters)" % (changed, chars))
    if changed == 0:
        print("nothing matched — the text may be spelled with look-alike letters; run office_dump.py")
        return 1
    if dry:
        print("--dry: file untouched")
        return 0

    body = restore_root_tag(ET.tostring(root, encoding="UTF-8", xml_declaration=True), raw)
    fd, tmp = tempfile.mkstemp(dir=base, prefix=".office_patch_", suffix=".docx")
    try:
        with os.fdopen(fd, "wb") as fh:
            with zipfile.ZipFile(fh, "w", zipfile.ZIP_DEFLATED) as out:
                for name, blob, kind, stamp in items:
                    info = zipfile.ZipInfo(name, date_time=stamp)
                    info.compress_type = kind
                    out.writestr(info, body if name == "word/document.xml" else blob)
        shutil.move(tmp, path)
        print("written: " + path)
    except Exception as exc:
        if os.path.exists(tmp):
            os.remove(tmp)
        print("FAILED, original left alone: %r" % (exc,))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
