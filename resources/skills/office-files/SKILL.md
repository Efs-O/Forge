---
name: office-files
description: Read, change and print Word/Excel/PowerPoint files on Windows without opening them, and drive a desktop app (Word, Excel, a printer dialog). Any .docx/.xlsx/.pptx job, "open this in Word", "print it", GUI automation.
---

# office-files

Three jobs this always repeats: **read** an Office file, **change** text in one,
**print** it and prove it went. The scripts do the reading and the printing; the rules
say when to touch the screen at all.

Every command below spells its script path as `<skill folder>` — substitute the folder
this `SKILL.md` lives in, which `load_skill` prints. Nothing in these scripts knows a
machine: no home folder, no drive letter, no user name.

## 1. Read it without opening it

`.docx`, `.xlsx`, `.pptx` are zip archives of XML. Reading the file beats opening the
app: no window, no focus fight, and you get the characters the app is hiding.

```text
python <skill folder>/scripts/office_dump.py "C:/path/to/file.docx"
```

It prints, per paragraph: the text, **how many runs it is split into**, and every
non-ASCII character with its codepoint and name. Both matter:

- **Runs.** One visible line is often a dozen separate runs (`27` `/` `7` apart). A
  string replace on the XML then misses it — this is how you know to use the app's own
  Find and Replace instead of file surgery.
- **Look-alikes.** Non-English files carry Latin letters that look like Greek or Cyrillic
  ones, typed with the wrong keyboard layout. Only the codepoint reveals it, and you must
  type exactly what the dump shows, never what the screen looks like.

Old `.doc` / `.xls` / `.ppt` are binary, not zips: open them in the app or convert.

## 2. Change text — pick the path by whether the app is open

| state | use |
| --- | --- |
| the app has the file open | the app's own **Find and Replace** (`ctrl+h`) — the only thing that guarantees a valid file, and it matches across runs |
| nothing has it open | `office_patch.py`, which rewrites whole paragraphs |

```text
python <skill folder>/scripts/office_patch.py "<file.docx>" --replace "27/7" "24/12" --dry
```

`--dry` prints what would change. Patching **flattens that paragraph's run formatting**
into the first run's font: fine for a one-line notice, wrong for a styled document. The
script refuses while Word holds the document open (its `~$name.docx` owner file sits next
to it). Then **re-read the file** with `office_dump.py` — a save you did not re-read is
not a save.

### Find and Replace through the screen

`ctrl+h`, then `find what` → `tab` → `replace with` → `Replace All`. The app answers with
a box: *"… has made 1 replacement"*. **Read that box.** "0 replacements" means your search
string is not the file's characters — go back to the dump.

## 3. Print — and prove it

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File <skill folder>/scripts/print_status.ps1
```

Run it **before** printing (it names the default printer, which is what you report to the
owner) and **after**. Then:

- **The queue is not proof.** A job parked in `Printing` with the printer at `processing`
  usually means the *driver* is waiting in its own preview window. Measured on one
  machine (Canon MB2700, 2026-11-16): the queue sat like that for three minutes while
  **Canon IJ Preview** waited on screen for a **Start Printing** click. So after clicking
  Print, take a `desktop_capture` (the driver's window by title, or the whole monitor) —
  that is the only evidence anything is moving.
- Printing from the app (`ctrl+p`) is the reliable path. `office_open_print.py print`
  uses the shell verb and still lands in the same driver preview if the driver has one.
- A finished print looks like: queue empty, printer state `idle`, preview window gone.
- You cannot see the paper. Say what you checked, and ask the owner to confirm the page.

## 4. Driving a window with the desktop tools (the rules that cost the most)

1. **`desktop_focus_window` immediately before every click or keystroke.** A
   `desktop_capture` approves a window but does **not** bring it forward, so the next
   action is refused with `target lost focus (foreground is '…')`. The chat's own editor
   window wins the foreground constantly while a turn is live.
2. **Read the focus line `desktop_click` reports.** It says whether keyboard focus moved
   and to which control — `Keyboard focus did not move (still Edit) — …`, or
   `Keyboard focus moved to another control of the same kind`. This is the fix for a
   measured case where a click on a dialog field reported `Clicked`, left the caret in the
   field above, and the next `desktop_type` appended there. Until focus moves, do not
   type. `tab` moves between fields reliably; `ctrl+a` then `delete` clears one.
3. **Re-capture after any popup.** A capture of a second window drops the first window's
   `capture_id`, and coordinates from an old screenshot are guesses.
4. **Prefer the app's keyboard to its mouse.** `ctrl+h`, `ctrl+s`, `ctrl+p`, `tab` cannot
   land on the wrong pixel.
5. **Tell the owner to keep their hands off the mouse** while you drive. Their cursor
   moving under your click is a race you both lose, and clicking into the chat steals the
   foreground you just took.
6. **`window_id` may be a number or text.** `desktop_windows` prints ids unquoted, so
   both forms are accepted and name the same window.

## 5. Report honestly

Say which printer you used, and say what you *checked* versus what you *assumed*.
"Job 4 is in the queue" is weaker than "queue empty, printer idle, preview closed".

## Measured on one Windows box — examples, not promises

- Word 2010: `ctrl+p` opens the **classic Print dialog** as its own window, not a
  gallery; `Find and Replace` is its own window too, so it needs its own focus + capture.
- No `PrintQueue` PowerShell module on that box, so `Get-PrintQueue` / `Get-PrintJob` do
  not exist — `print_status.ps1` uses `Win32_PrintJob` and `Win32_Printer` instead.
- A Python script that prints non-English text needs `sys.stdout.reconfigure` to UTF-8
  first, or a legacy console codepage dies on it.
- Non-ASCII paths go through Python and `os.startfile` safely; `cmd //c start` and
  `explorer.exe` can mangle them when called from a POSIX shell.
