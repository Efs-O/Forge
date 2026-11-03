---
name: hf-download
description: Download models or datasets from Hugging Face fast (parallel ranged connections, resume, hash check). Use instead of `hf download` / `huggingface-cli download`.
---

# hf-download

One Hugging Face connection is slow — about 2 MB/s measured on 2026-10-24, and
`hf download` opens one connection per file. `scripts/hf_parallel_dl.py` splits
each file of 64 MiB or more into parallel HTTP range requests and reaches
80-104 MB/s. It uses the Python standard library only, so any `python` runs it,
and it needs no Forge window open.

Run the script by the absolute path `load_skill` returned for it — the folder is
inside Forge's install folder, so do not guess at it:

```text
python <skill folder>/scripts/hf_parallel_dl.py REPO [FILES...] --dest DIR [options]

  FILES              paths inside the repo (e.g. Q4_K_M/model-00001-of-00003.gguf)
  --include GLOB     match repo paths instead of naming them; repeatable ("Q4_K_M/*.gguf")
  --dest DIR         target folder (required)
  --flat             drop the repo sub-folders, putting every file directly in DIR
  --revision REV     branch, tag or commit (default main); pin a commit for reproducible sets
  --repo-type T      model | dataset | space (default model)
  --parts N          parallel connections per large file, 1-32 (default 12; 8-16 is the useful range)
  --sha256 F=HEX     an extra pin to check a file against; repeatable
  --no-verify        skip the hash check (not recommended)
```

Examples:

```text
python <skill folder>/scripts/hf_parallel_dl.py unsloth/Some-GGUF --include "Q4_K_M/*.gguf" --dest /models/Some --flat
python <skill folder>/scripts/hf_parallel_dl.py org/repo file.gguf --dest /models/x --revision 0123abc
```

Behaviour:

- **Hash checks.** Every finished file is checked. LFS files are checked against
  the SHA-256 the Hub publishes, and small git files against their git blob
  SHA-1. A successful run ends with `ALL OK`; a failure ends with `FAILED: ...`
  and exit code 1. Do not report a download as done without that line.
- **Resuming.** An unfinished download is kept as `<file>.dl`, and its progress as
  `<file>.dl.json`. To resume, run the same command again; the remaining bytes are
  re-split across all `--parts` connections.
- **Token.** The script reads `HF_TOKEN`, else `%HF_HOME%\token`, else
  `~/.cache/huggingface/token`. It sends the token to huggingface.co only, never
  to the CDN the Hub redirects to. A token in VS Code's secret storage is
  encrypted and unreadable to scripts, so to use a different one, set `HF_TOKEN`
  or run `hf auth login`.
- **Rate limits.** An HTTP 429 is honoured by waiting for `Retry-After`. An
  expired signed CDN URL (401/403/410) is replaced with a new one from the Hub.
  Network errors are retried 30 times with backoff.
- **Long downloads.** Run it in the background (Forge: `shell` with
  `background: true, notify_on_exit: true`) and read the log; progress is logged
  every 15 s. A foreground call will hit the shell timeout on a big file.

Is it allowed? Range requests are standard HTTP, and the Hub's CDN serves them
(`hf_transfer` and `hf_xet` download in parallel too). Keep `--parts` at 16 or
fewer, and avoid running many files at once.
