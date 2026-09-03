# Forge Voice Input / STT / TTS Implementation Plan

Status: implementation handoff, research-reviewed revision
Target: Forge `main`
Date: 2026-09-03 (revised same day — §27 prior-art sweep folded into the body)

**Read this first.** §27 catalogues prior art found in the sibling workspaces on
this machine, and it contradicted several decisions in the original body. Those
contradictions have now been resolved **in place** — §6 (STT backend), §8.3
(capture), §9.2 (attachments), §21 (JOY licence) and §24 (tests) carry the
corrected decision, and §27.6 records which delta landed where.

A **second revision pass** (same day) then closed the implementation-readiness
gaps: executable contracts for every STT candidate and a third candidate
(§6.1), the `PendingVoiceDraft` state machine (§9.6), the temp-file audio
transport decision (§9.2), the three-event audit schema (§20.1), the operational
admission rule (§7), phase- and tier-split tests with a required fake runner
(§24), mandatory Phase 1 silence trimming, and removal of Telegram voice-only
output (§17). Do not implement
from an older copy of this file: it recommends a GPU whisper.cpp backend, a
`large-v3-turbo` default, and a Telegram emoji rejection guard that are all
withdrawn.

## 1. Goal

Add a complete local-first voice path to Forge without creating a second agent loop and without requiring the coding model to consume audio directly.

The feature should support:

- Telegram voice messages as the primary — and initially only — input path;
- spoken approvals, `/steer` and cancellation over a closed grammar (§8A);
- microphone input from the Forge sidebar **only if** the gate in §8 opens;
- local speech-to-text through `whisper.cpp`;
- Greek and English transcription;
- immediate and verifiable STT GPU release after transcription;
- delivery of the transcript through the existing Forge prompt-admission path;
- optional local text-to-speech through Piper;
- Greek TTS using the existing JOY Piper voice;
- configurable English Piper voices;
- code-aware speech rendering;
- technical-term pronunciation control through Piper raw-phoneme spans when supported;
- deterministic text-normalization fallback;
- spoken status notifications from a fixed template set (§12A), before any
  general response reading;
- text-only, text+notification, or text+voice output policies per surface;
- forensic legibility: every voice turn explainable from the session log (§20.1);
- no second LLM call merely to make ordinary responses speakable.

Central rule:

> Voice is an I/O transport around the existing Forge agent loop, not a new agent mode.

The coding model should continue to receive ordinary UTF-8 user text. The conversation should continue to store the exact original assistant text.

---

## 2. Research findings that materially change the first draft

### 2.1 Do not assume a VS Code webview can directly open the microphone

The initial draft proposed `navigator.mediaDevices.getUserMedia()` / `MediaRecorder` inside the Forge webview. Do **not** make that the primary implementation.

VS Code has an open webview issue where microphone access is rejected by the webview permissions policy (`microphone is not allowed in this document`). This means a webview-only microphone implementation can fail even though the same browser APIs work in normal Chromium pages.

Reference:
- https://github.com/microsoft/vscode/issues/250568

**Revised decision:** the sidebar microphone button is UI only. Actual microphone capture belongs in an extension-host-owned local helper/process.

### 2.2 `whisper.cpp` already ships tested microphone examples

`whisper.cpp` provides:

- `whisper-stream`: real-time microphone transcription;
- `whisper-command`: a basic local voice-assistant command receiver;
- SDL2 microphone capture;
- VAD support;
- CPU and GPU inference;
- Windows support in the main project;
- current C/C++ API and CLI tools.

References:
- https://github.com/ggml-org/whisper.cpp/tree/master/examples/stream
- https://github.com/ggml-org/whisper.cpp/tree/master/examples/command
- https://github.com/ggml-org/whisper.cpp

These are useful references and possible future helpers, but Phase 1 should still prefer a one-shot process lifecycle for the strongest VRAM-release guarantee.

### 2.3 `whisper.cpp` Node addon exists, but it is not the best Phase 1 fit

Current whisper.cpp includes an `examples/addon.node` implementation for Node/Electron and supports VAD, direct PCM float input, language auto-detection, GPU selection and progress callbacks.

Reference:
- https://github.com/ggml-org/whisper.cpp/tree/master/examples/addon.node

This looks attractive for Forge because the extension host is Node/Electron. However:

1. native addons are coupled to Node/Electron ABI and increase packaging/build complexity;
2. Windows native-addon builds require a toolchain;
3. Forge's hard requirement is to release Whisper GPU memory immediately after every voice command;
4. a short-lived external process gives a stronger teardown boundary than a library loaded into the long-lived extension host.

**Decision:** keep the Node addon as a Phase 2 optimization candidate, not the Phase 1 backend.

### 2.4 Do not use `whisper-server` as the default STT runtime

A resident transcription server saves model load time, but it intentionally keeps Whisper loaded. That conflicts with the current requirement that STT give its memory back as soon as the transcript is obtained.

**Decision:** do not use a persistent Whisper server in Phase 1.

### 2.5 Piper raw-phoneme injection is a real supported feature

The maintained OHF Piper line supports raw espeak-ng phoneme spans inside normal input text:

```text
I am [[ bˈætmæn ]]
```

Ordinary text is phonemized normally while the `[[ ... ]]` section supplies explicit phonemes.

References:
- https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/CLI.md
- https://github.com/OHF-Voice/piper1-gpl/blob/main/CHANGELOG.md

Piper also exposes lower-level phoneme/phoneme-ID APIs. For Forge, raw phoneme spans are the best initial pronunciation-control point because they do not require modifying the JOY ONNX model.

### 2.6 Maintained Piper now has `libpiper` and Windows build support

OHF Piper 1.5+ restored a C/C++ API/CLI and explicitly fixed Windows builds using MSVC/MSYS2-GCC.

Reference:
- https://github.com/OHF-Voice/piper1-gpl/tree/main/libpiper

This is useful for a future native integration, but Phase 1 should still use a separate process interface unless there is a strong measured reason to embed it.

### 2.7 Piper licensing must be treated explicitly

The maintained `OHF-Voice/piper1-gpl` repository is GPL-3.0, while Forge is Apache-2.0.

Phase 1 should **not** silently link or bundle GPL Piper code into the Forge extension. Prefer a user-configured external Piper executable/runtime and model path until redistribution/linking policy is intentionally decided.

Invoking a separately installed executable is also architecturally cleaner for Forge's current local-runtime model.

### 2.8 Current Forge Telegram attachment code needs a binary-audio path

Current `TelegramChannel.ts` recognizes `document` and `photo`, but not Telegram `voice` objects. More importantly, `downloadAttachment()` currently turns non-image/non-PDF data into UTF-8 text. Audio must never pass through that branch.

Therefore Telegram voice support requires:

1. schema support for `message.voice`;
2. a binary attachment representation or dedicated binary download method;
3. no `bytes.toString('utf8')` for audio;
4. size/duration validation before download/transcription.

This is an implementation requirement, not an optional cleanup.

### 2.9 Phase 1 emoji policy (revised 2026-09-03 — inbound guard withdrawn)

An earlier revision of this plan proposed **rejecting every inbound Telegram text
prompt containing emoji** before prompt admission. That is withdrawn. Do not
implement it.

Reasons:

- **No inbound emoji failure has ever been recorded.** The only emoji bug in
  Forge's history is outbound: the 4,096-character Telegram splitter could cut
  between the UTF-16 halves of a surrogate pair. It was fixed on 2026-08-31 and
  the splitter now walks whole code points
  (`docs/reports/RECENT_IMPLEMENTATION_AUDIT_2026-08-31.md` §4). Building a
  guard against an unobserved failure costs implementation time, a config flag
  and a test row, and buys nothing measurable.
- **It is a user-visible regression on a shipped feature.** `👍 ship it` is an
  ordinary remote prompt today. Refusing it teaches the user the remote path is
  unreliable — the same class of mistake as a guard pattern matched as a
  substring (see CLAUDE.md, *Never match a guard pattern as a substring*).
- **It is orthogonal to voice.** By this plan's own argument, voice transcripts
  contain no generated emoji and need no STT handling — which is precisely why
  the input guard is not part of the voice path.

**What remains Phase 1 policy:**

- assistant text remains untouched in UI, history and Telegram, and may contain
  emoji;
- the TTS `SpeechRenderer` strips emoji from the **speech-only copy** before
  Piper (§13) — this is the one real requirement, it is cheap, and it is
  independent of anything inbound;
- inbound text handling on every surface is unchanged by this feature;
- if an inbound emoji defect is ever actually observed, fix that defect; do not
  reintroduce a blanket rejection.

Emoji detection in the `SpeechRenderer` should be Unicode-aware (property
escapes, whole grapheme clusters) rather than an ASCII-range hack.

---

## 3. Revised architecture

```text
INPUT

Forge sidebar mic button                  Telegram voice note
        |                                         |
        |                                Telegram Bot API voice object
        |                                         |
        v                                         v
extension-host capture helper              binary OGG/Opus download
        |                                         |
        +-------------------+---------------------+
                            |
                       VoiceIngress
                            |
                   AudioNormalizer
                            |
                 temporary 16 kHz mono WAV
                            |
                 short-lived whisper.cpp
                      process per prompt
                            |
                        transcript
                            |
              WAIT FOR PROCESS EXIT / CLEANUP
                            |
                  HARD STT RELEASE BARRIER
                            |
                existing prompt admission
                            |
                  existing Forge agent loop
                            |
                        Qwen/etc.
                            |
                    assistant response
                     /              \
                    /                \
          original text           SpeechRenderer
          UI + history                 |
                                      |
                              strip emoji (Phase 1)
                                      |
                              code-aware normalization
                                      |
                              pronunciation lexicon
                                      |
                         optional Piper [[phonemes]]
                                      |
                         external local Piper process
                                      |
                                generated WAV/PCM
                                  /           \
                                 /             \
                         sidebar playback   Telegram voice/audio
```

Two hard separation rules:

1. No transcript enters the conversation until the STT process has completely exited and temporary STT GPU resources are gone.
2. No TTS-normalized text replaces the original assistant response in UI/history.

---

## 4. Existing Forge surfaces to reuse

Keep existing Forge paths authoritative:

- `src/remote/TelegramChannel.ts`
- `src/remote/RemoteAttachmentStore.ts`
- `src/remote/RemotePromptAdmission.ts`
- `src/remote/RemoteQueueDrain.ts`
- `src/remote/RemoteController.ts`
- `src/sidebar/AgentLoop.ts`
- existing conversation persistence
- existing model/runtime lifecycle patterns
- existing process execution and cancellation patterns

Do not create a voice-specific agent loop.

Voice input must eventually become the same kind of normal text prompt that typed input becomes.

---

## 5. Proposed new modules

Names are suggestions and should follow current Forge naming conventions after implementation begins.

```text
src/voice/
  VoiceTypes.ts          # owns the voice message/config types
  VoiceIngress.ts        # audio in -> transcript out, the one cancellable unit
                         # ENTRY POINT TAKES A FILE PATH — see the fixture note
  AudioNormalizer.ts     # anything -> 16 kHz mono s16 WAV (uses ffmpegLocate)
  MicrophoneCapture.ts   # ffmpeg device enumeration + capture (Phase 2)
  WhisperRunner.ts       # spawn STT process, transcript, exit barrier
  SpeechRenderer.ts      # assistant Markdown -> speech-only string
  PronunciationLexicon.ts
  PiperRunner.ts         # spawn Piper (both CLI dialects), voice scan/select
  VoiceOutputRouter.ts   # per-surface text/voice policy
```

Changed from the earlier revision: **`WhisperLifecycle.ts` and
`PiperLifecycle.ts` are folded into their runners.** No seam was ever stated
between "run the process" and "manage the process's life", and splitting on that
non-seam is exactly the failure CLAUDE.md names — a reader jumping files to
follow one thought. Split them later if a runner actually crosses 350 LOC with
two separable concerns in it; the 500 LOC ceiling is enforced by eslint either
way.

**Ownership registration (required, not optional).** Per the Single Point of
Truth rule, each of these gets a row in `docs/OWNERS.md` **in the commit that
creates it**. Two owners outside `src/voice/` are also affected and must be
extended rather than duplicated:

- the `voice:` config block is owned by `src/config/schema.ts` +
  `src/config/types.ts` — do not create a voice-local config parser;
- ffmpeg discovery stays owned by `src/tools/ffmpegLocate.ts` (§8.3).

And per the same rule's second half: every exported method here needs a caller in
the same commit. A `cancel()` with nothing wired to it is the `ask_user` bug
again.

**Design the test seam into `VoiceIngress` from the first commit.** Its entry
point takes a **path to an audio file**, never a microphone handle, a Telegram
`file_id`, or a network stream. Those belong to the callers above it.

With that one constraint, the entire Telegram → normalize → transcribe → filter →
admission path is unit-testable against checked-in WAV fixtures — no microphone,
no Telegram token, no network, no GPU. Given that most of this plan's risk sits
in transcription quality, having Greek and English fixtures from day one is what
makes it possible to swap STT backends (§6.1), tune the bias prompt (§6.4) or
change models later **without re-listening to everything by hand**.

Check in a small fixture set alongside the Phase 0 recordings: a Greek command, an
English command, a Greek command containing English technical terms, a
silence-only clip, and one clip with long trailing silence (the §27.1
hallucination trigger).

Optional built-in resources:

```text
resources/voice/
  pronunciations.en.json
  pronunciations.el.json
```

Optional workspace/user override:

```text
.forge/tts-pronunciations.json
```

Workspace/user entries override built-ins.

---

## 6. STT backend (revised 2026-09-03 after the §27 prior-art sweep)

### 6.1 Phase 1 decision — three candidates, and an executable contract for each

**Revised again 2026-09-03 (second pass).** The previous revision named CPU
faster-whisper the default on accuracy and VRAM grounds but never said *what
Forge launches*. Writing that contract down changes the answer, because it
surfaces a third candidate that the §27.1 evidence never tested.

#### The candidate that was missing: whisper.cpp on CPU

§27.1 measured **CPU faster-whisper** against **GPU whisper.cpp**. That comparison
conflates two independent variables — engine and device — exactly the mistake
CLAUDE.md warns about with weight quant versus KV quant. Nobody measured
**whisper.cpp on CPU**, and on packaging it dominates both:

| | whisper.cpp (CPU) | faster-whisper (CPU) | whisper.cpp (GPU) |
| --- | --- | --- | --- |
| What Forge spawns | one `.exe` | a Python interpreter | one `.exe` |
| Runtime dependency | none | Python + venv + ctranslate2 | CUDA runtime |
| Model file | one `ggml-*.bin`, explicit path | HF cache dir or snapshot path | one `.bin` |
| Offline by construction | yes | **no — must be forced** | yes |
| VRAM taken | zero | zero | contended (§7) |
| Accuracy (measured) | untested | strongest (§27.1) | untested at CPU parity |

The VRAM argument that promoted faster-whisper applies just as well to
whisper.cpp on CPU, without importing a Python runtime into a VS Code extension.
**Benchmark all three in Phase 0.** If whisper.cpp CPU is close enough to
faster-whisper on the Greek command set, it wins on packaging alone and Phase 1
gets much simpler.

#### Executable contract — whisper.cpp (either device)

```text
spawn: <voice.stt.binary> -m <voice.stt.model> -f <wav> -l <lang>
       -otxt -of <tmp-out> --no-prints [--prompt <bias>] [-ng]
read:  <tmp-out>.txt
```

Self-contained. `voice.stt.binary` and `voice.stt.model` are absolute paths the
user supplies, exactly like `llama_server_binary` and a GGUF. `-ng` forces CPU.
No network is reachable from this path by construction — which is the cleanest
possible answer to the no-unapproved-network rule.

#### Executable contract — faster-whisper (only if it wins Phase 0)

faster-whisper is **a Python library, not a CLI.** There is no
`faster-whisper` executable to spawn. So this backend costs Forge a Python
contract, and that contract must be explicit before it is chosen:

1. **Forge never manages a Python environment.** No venv creation, no `pip
   install`, no interpreter discovery beyond an explicit configured path. The
   user points `voice.stt.python` at an interpreter that already has
   `faster-whisper` importable, or this backend is unavailable.
2. **Forge ships a small vendored runner script** (`resources/voice/stt_faster_whisper.py`,
   generated-file-exempt from the LOC rule) that reads a WAV path, prints a JSON
   transcript to stdout, and exits. Forge spawns
   `<python> <runner> --model <dir> --wav <path> --language <l>`. The script is
   the process contract; Forge validates the library against the compatibility
   range in item 8, while installation and environment ownership remain with the
   user.
3. **`voice.stt.model` is a local directory, never a Hugging Face ID.** A bare ID
   makes the first transcription a silent multi-gigabyte download — outbound
   traffic Forge never authorised. Reject a value that is not an existing
   directory, and say so.
4. **The runner sets `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` in its own
   environment** before importing, so a misconfiguration fails loudly instead of
   downloading. §27.1 notes the Ssuno reference script already does this.
5. **Force UTF-8 stdout** in the runner. The console here is cp1253 and Greek
   output will otherwise raise or mojibake — measured, §27.1.
6. **Missing interpreter, missing library or missing model produce a typed error
   naming the fix**, in the shape of `FfmpegMissingError`. Never a bare spawn
   ENOENT.
7. **CPU only.** §27.1 found ctranslate2's CUDA path broken on this machine
   (missing `cublas64_12.dll`) and silently falling back to CPU int8 — a silent
   fallback is precisely what the no-fallbacks rule forbids. If GPU is ever
   wanted here, it must be explicit and verified, not inherited.
8. **Forge owns a tested compatibility contract for the runner.** Pin the
   faster-whisper version used in Phase 0, document the supported range, and run
   a startup capability probe (`import faster_whisper`, constructor signature,
   local model load) before accepting the backend. The environment remains
   user-managed, but compatibility is not "the user's business" once Forge
   ships a script that calls the library API.

If those seven points feel heavy, that is the finding: they are the real cost of
the faster-whisper default, and they are why whisper.cpp CPU must be measured
before committing to it.

#### What is backend-independent

`WhisperRunner` is written against *"spawn a process, hand it a WAV path, get a
transcript, observe exit"* — never against one engine's argv. Both contracts
above fit it. Selecting a backend must not require touching `VoiceIngress`,
`AudioNormalizer`, the draft state machine (§9.5), or the audit events (§20.1).

#### What may be built before the bake-off

The earlier revision said *"nothing else in this plan should be written until one
wins."* That is too strict and would idle the whole Phase 1 slice. Correctly:

- **May be built now** — the `WhisperRunner` interface, the fake runner (§24),
  `AudioNormalizer`, the Telegram schema and attachment fix (§9.2), the draft
  state machine (§9.5), the audit events (§20.1), the fixtures, and the benchmark
  harness itself.
- **Waits for the winner** — the concrete runner implementation, the config
  defaults, the install/diagnostics messages, and anything that names an engine.

### 6.1a FIRST MEASUREMENTS (2026-09-03) — both CPU candidates fail the latency gate

Run on this machine with the CPU idle (10% load, verified) against the synthetic
smoke corpus. **Latency does not depend on audio realism, so these numbers stand
even though the fixtures are synthetic** (§24). Accuracy observations below are
smoke-only and decide nothing.

| Candidate | Short utterance (0.8-1.2 s audio) | Model load |
| --- | --- | --- |
| whisper.cpp large-v3, CPU, 4 threads | 28,477-54,069 ms | included |
| whisper.cpp large-v3, CPU, 12 threads | 16,793 ms | included |
| faster-whisper large-v3, CPU int8 | 9,035-9,889 ms | **12,595 ms** |

**Against the R2 gate of ≤3 s wall-clock WAV-ready→transcript including load,
every CPU/large-v3 combination fails by 5-18x.** As a one-shot process per
utterance (§6.1), faster-whisper is ~21.6 s cold.

Three conclusions, in order of how much they change the plan:

1. **§27.1's headline number does not transfer.** It recorded faster-whisper at
   "~1 s for a 4.5-minute track" and §6.1 made CPU faster-whisper the default on
   that basis. Measured on *short command utterances* — Forge's actual case — it
   is ~9 s plus a ~12.6 s load. The plan already warned to re-benchmark turbo for
   short utterances before trusting it; the same caution was never applied to the
   number the default was built on. **Apply it now: no §27.1 latency figure is
   valid for this workload until re-measured.**
2. **Model load dominates, which indicts the one-shot process design, not the
   engine.** 12.6 s of a 21.6 s cold path is loading weights. §2.4 rejected a
   resident STT server to guarantee VRAM release — but on CPU there is no VRAM to
   release, so that justification does not apply to the CPU candidates at all. A
   resident CPU process is back on the table and must be measured (it would still
   leave ~9 s of inference, so it is necessary but likely not sufficient).
3. **large-v3 is probably the wrong size.** The remaining untested paths are GPU
   (blocked here: 15.4/16.3 GB VRAM was resident, and §27.1's one-model-at-a-time
   rule applies) and a **smaller multilingual model** — turbo, medium, or small.
   §6.2 deprioritized turbo on a long-audio hallucination finding; that
   deprioritization now costs the only candidate likely to meet the latency gate,
   and must be revisited on short utterances specifically. No smaller multilingual
   model is present locally; fetching one needs explicit authorization.

**Smoke-only accuracy observations** (synthetic audio, n=1 per line, decides
nothing — recorded here because two of them are informative):

- `approve` → `"Approve."` on both engines. The English grammar matches.
- `εντάξει` → `"Έτσι."` on **both** engines, identically. Since two independent
  engines agree, suspect the fixture or the isolated-word context rather than the
  backend. The grammar correctly does not match, so this is a miss, not a false
  authorization.
- `μην εγκρίνεις` → `"Μην ενκρίνεις."` on both. **The negation survived**, which
  is the safety-critical half, and the grammar correctly refuses to match it.
  This is the R3 gate behaving as designed.
- `trailing-silence` (1.5 s speech + 6 s silence) → `"Restart the backend."` with
  no appended line on either engine. The §27.1 hallucination did not reproduce on
  clean synthetic audio — which is exactly why the R3 corpus must be **recorded**.

### 6.1b SECOND MEASUREMENTS (2026-09-03) — GPU + the recorded corpus settle it

The §6.1a numbers were taken with the GPU fully occupied, so they measured CPU
only. With the GPU free (946 / 16311 MiB) and the **recorded** 17-utterance
corpus in place, the picture inverts.

**whisper.cpp large-v3, CUDA, greedy, 17 recorded clips:**

| Shape | Per utterance |
|---|---|
| One process per clip (current §2.4 design) | 4,195 – 4,673 ms |
| 10 clips in one process (6,318 ms total) | **~250 ms**, after a ~3.8 s load |

Two conclusions, and the second is the important one:

1. **GPU is 4–13x faster than CPU** on short utterances (4.2 s vs 16.8–54.1 s).
   §6.1a's CPU-only verdict does not survive contact with a free GPU.
2. **The one-shot spawn IS the latency.** The per-clip time is flat at ~4.2 s
   across audio from 1.5 s to 8.0 s, which is the signature of fixed overhead,
   not inference. Amortized, a clip costs ~250 ms — **12x inside R2's 3 s gate**.
   The gate is not a model-size problem or an engine problem. It is §2.4's
   process model, and §2.4's justification for it (VRAM contention) is a real
   constraint that now has a measured price attached: ~4 s per utterance.

**faster-whisper on GPU could not be measured, and that is itself the finding.**
CTranslate2 aborts with `Library cublas64_12.dll is not found or cannot be
loaded`. The wheel ships `cudnn64_9.dll` but not cuBLAS, and no CUDA 12 runtime
is installed. Fixing it means a ~500 MB out-of-band NVIDIA dependency that the
**end user** would have to install correctly on their own machine. The user has
hit this exact wall before and resolved it the same way — it is why ComfyUI work
here moved to llama.cpp.

That reframes the choice. §6.1 treated engine selection as a latency question;
for something shipped in a VS Code extension to strangers it is primarily a
**deployment** question, and there whisper.cpp wins outright: a self-contained
`.exe` plus a `.bin`, no Python, no runtime DLLs, no CUDA toolkit. A faster
engine that a fraction of users cannot start is slower than a slower one that
always starts.

**Recorded-corpus accuracy — the R3 gate PASSES.** Now enforced as a test rather
than an observation: transcripts are checked in at
`test/fixtures/voice/transcripts-whispercpp-large-v3-cuda.json` and asserted by
`test/unit/VoiceGrammarCorpus.test.ts` (Tier A — no binary, model or GPU needed).
25 assertions, all passing.

- **Zero false authorizations across all six negated utterances.** The one worth
  naming: `μην εγκρίνεις` was heard as **`"Μείνα εγκρίνης."`** — badly mangled,
  the negation destroyed — and the grammar still refused, because whole-utterance
  matching cannot match a two-word phrase. No developer would have invented that
  string as a test case. It is the argument for a recorded corpus in one line.
- Plain commands all resolve: `Εντάξει.` → approve, `Όχι.` → deny, `Approve.`,
  `Deny.`. Note `εντάξει` was **correct on real speech** but wrong (`"Έτσι."`) on
  the Piper fixture — the synthetic entry was the unreliable one, exactly as the
  manifest warns.
- Free-form prompts stay prompts. `"Open src/voice/voiceingress.ts and check the
  admission rule."` — path structure survived dictation.
- **No trailing-silence hallucination** on 6 s of real recorded silence. The
  §27.1 failure did not reproduce; the conservative `SILENCE_TRIM_FILTER` bias
  toward keeping audio is not costing anything measurable yet.
- Known misses, all benign: `VRAM` → `vrun`, `this` → `these`, `έλεγξε` →
  `έλεξε`. None touch a control word. §6.4 decoder bias is the mitigation and is
  now justified by measurement rather than by anticipation.

**Model size is SETTLED at large-v3 — by the Ssuno repo, not by this plan.**
`N:/vs code apps/Ssuno/docs/AUDIO_AND_DOWNLOADS.md` records turbo already tested
and **deleted**: it "dropped a whole final-refrain couplet and hallucinated the
outro ~40x". That is the §27.1 trailing-hallucination failure, worse, on the
model §6.2 was going to reconsider. The same document independently reports
faster-whisper's CUDA path broken on this machine — the identical finding, made
before this measurement. No download is needed and none should be requested.

That document also states whisper.cpp "holds VRAM, so it obeys the same
one-model-at-a-time rule as ComfyUI", which is direct external support for
§2.4's contention concern — and makes the resident-process question above a real
architectural tradeoff rather than an obvious win.

**What this does NOT settle:** the R7 silence-filter sweep, and microphone/noise
variation (one speaker, one device, quiet room; n=1 per line). Neither blocks
implementation. Both are regression questions to revisit if a real user reports a
miss — collecting more corpus now would be measuring a system that has not been
built yet.

### 6.2 Model candidates

Benchmark in Greek and English:

1. `whisper.cpp large-v3` on CPU — the packaging reference and previously
   missing candidate (§6.1);
2. `faster-whisper large-v3` on CPU int8 — the accuracy reference, and the
   Phase 1 default until something beats it (§27.1);
3. `whisper.cpp large-v3` on GPU — the latency challenger;
4. `large-v3-turbo` — **do not assume this is the practical choice.** An earlier
   revision of this plan recommended it. It was deleted from this machine on
   purpose: it dropped a final-refrain couplet and hallucinated an outro roughly
   40 times on a real track (§27.1). It may still be fine for 3-second commands,
   but that is now a claim requiring a short-utterance re-benchmark, not a
   default;
5. quantized turbo variants — only after (4) is re-established, and only if Greek
   quality holds.

Never use `.en` checkpoints when Greek input is enabled — measured, not assumed
(§27.1: `small.en` / `tiny.en` dropped quiet passages).

Default language policy:

```text
auto
```

Expose explicit `el` and `en` for testing and troubleshooting.

### 6.3 Use current stable whisper.cpp, not an old copied binary

At implementation time pin a tested whisper.cpp release. The project is actively changing; VAD, device selection, ffmpeg decoding and bindings have continued evolving in 2026.

Record the tested version in Forge docs/config diagnostics.

---

### 6.4 Bias the decoder with Forge's own vocabulary

**Added 2026-09-03. Do this in Phase 1 — it is the cheap half of the
pronunciation problem, and it pays off before any TTS work starts.**

§14 spends real effort teaching Piper to *say* `CUDA` and `Qwen`. The mirror
problem — whisper *hearing* them — is solved far more cheaply, because both
candidate backends already expose a decoding-bias hook:

- `whisper.cpp`: `--prompt "<text>"` (initial prompt tokens);
- `faster-whisper`: `initial_prompt=` and `hotwords=`.

Seed it with a fixed technical list — the same terms §15 lists for the phoneme
prototype is a good starting set:

```text
Forge, TypeScript, JavaScript, Python, npm, git, CUDA, VRAM, NVIDIA, Qwen,
llama.cpp, Ollama, JSON, YAML, API, HTTP, GGUF, refactor, commit, checkpoint
```

Optionally extend it with the current workspace's most frequent identifiers.
Keep it **short** — an over-long bias prompt is itself a documented whisper
hallucination trigger, and it consumes the same context the audio needs. Treat
its length as a tunable to measure in Phase 0, not a place to dump a dictionary.

**This is what makes §16's hardest case work.** Greek speech containing English
technical terms is the realistic daily input here, and it is precisely where an
unbiased multilingual decoder transliterates `commit` into Greek phonetics or
drops it. Measure with and without bias on the Greek command set in Phase 0; the
delta is the justification.

Config key: `voice.stt.initial_prompt` (§18). Empty disables it.

---

## 7. STT lifecycle and VRAM policy

### Hard invariant

```text
capture complete
  -> launch Whisper
  -> transcribe
  -> collect transcript
  -> terminate normally
  -> await child-process exit
  -> delete temp audio
  -> only then dispatch completed text to command/draft/admission handling
```

For Phase 1 the strongest release barrier is **child process exit** — and on the
CPU faster-whisper path (§6.1) there is nothing to release in the first place,
which is the point. This section's invariant still applies unchanged: it also
covers temp-file cleanup and the "do not admit a partial transcript" rule, which
are backend-independent.

Pseudo-code:

```ts
const result = await whisperRunner.transcribe(tempWav, options);
await result.processExited;
await cleanupTempAudio(tempWav);
await handleCompletedVoiceText(result.text); // §8A / §9.5 / §9.6
```

Do not call prompt admission merely because a line of transcript has appeared on
stdout. Wait for successful terminal process completion.

#### The admission rule, stated operationally

"Never admit a partial transcript" is not testable as prose. Process exit proves
the process was not interrupted; it does **not** prove the utterance was
transcribed completely. Admit only when **all** of these hold:

1. the STT process exited with status 0, and was not cancelled;
2. the transcript artifact (`.txt` or the runner's JSON) was read **after** exit
   and parsed in full — never streamed, never read while the process is live;
3. the normalized transcript is non-empty after trimming whitespace and the
   documented marker tokens emitted by the selected backend (`[BLANK_AUDIO]`,
   `[music]`, and similar);
4. backend-specific validation succeeds. `looksLikeTranscriptionRefusal()` and
   `stripPromptEcho()` came from an instruction-following audio-LLM path and
   must **not** be applied blindly to whisper.cpp or faster-whisper. Enable a
   filter only for a backend that can emit that failure shape, and prove it
   against positive and false-positive fixtures first;
5. no cancellation was requested at any point in the operation.

Any failure emits `voice_ingress_rejected` with the matching reason (§20.1) and
creates no user turn.

**What this deliberately does not promise.** Forge cannot detect an utterance
that was *semantically* truncated — audio that cut off mid-sentence still
transcribes cleanly and exits 0. Neither whisper.cpp nor faster-whisper exposes a
signal for it. Do not write a test asserting detection of that case, and do not
imply the guarantee to users. The §9.5 draft echo is the real mitigation: the
user reads the transcript and sees it end mid-thought. That is another reason
draft-by-default is the correct posture rather than a nicety.

### VRAM policy

Applies only if Phase 0 selects the GPU backend. The CPU faster-whisper path
skips this section entirely — no scheduler, no eviction question, no contention
with the coding model.

Priority:

1. GPU Whisper if it fits without disturbing the coding model;
2. CPU Whisper if GPU allocation would require evicting the coding model;
3. configurable secondary GPU when available;
4. unloading/reloading Qwen only as explicit last-resort behavior.

Why: unloading Qwen costs model reload time and can destroy warm prefix/KV advantages for a very short voice command.

### 7.1 Second GPU (hardware arriving 2026-09-04) — priority 3 becomes the default

The "configurable secondary GPU" above stops being a hypothetical. A second card
arrives 2026-09-04 and is intended for Whisper, which changes the shape of this
section rather than just its numbers:

- **The contention this policy exists to manage goes away.** Priorities 2 and 4
  (CPU fallback, evicting Qwen) were both there to protect the coding model's
  residency on a single 16 GB card. With Whisper on its own device there is
  nothing to evict and nothing to fall back from, so the scheduler this section
  warns against building is not merely premature — it is unnecessary.
- **`keep_model_loaded` stops being a tradeoff.** It is the 4195 ms → ~250 ms
  lever (§6.1b: per-clip time is flat across 1.5 s–8.0 s audio, so it is model
  load, not inference). On one card it would park ~3 GB permanently against
  Qwen; on a dedicated card that objection disappears and a resident whisper
  process becomes the obvious next step. It is in the config schema today and
  honored by nothing.
- **The current failure mode is thrash, not OOM.** Under WDDM the driver spills
  to system RAM rather than failing the allocation, so a collision degrades both
  Whisper *and* the resident model for the duration instead of surfacing an
  error. That is the worse of the two outcomes, because nothing is reported.
  The window is only the ~4 s of a one-shot spawn, and it collides only if a
  voice note arrives mid-generation — but it is unreported when it does.

**Device pinning is not free config today.** whisper.cpp selects its device via
`CUDA_VISIBLE_DEVICES` in the environment. `WhisperCppRunner` spawns with
inherited env and no explicit device, so it will land on whichever card CUDA
enumerates first — which is not necessarily the new one. Pinning needs a device
setting in the `voice:` block (§18) threaded into the spawn env; it is small,
but it is a change, not a setting that already exists. **Confirm what enumerates
as device 0 before writing it** — if the new card enumerates first, the correct
change may be none at all.

**Piper cannot use the second GPU, and does not need to.** Verified against the
installed binary rather than assumed: `piper.exe --help` exposes no `--cuda` /
`--use-cuda` flag, and the install ships `onnxruntime.dll` +
`onnxruntime_providers_shared.dll` with no `onnxruntime_providers_cuda.dll`.
Both the flag and the execution provider would have to be present, and neither
is — GPU builds of Piper exist upstream, but this is not one. It measures
611–1995 ms on CPU (§11.3's threshold), touches no VRAM, and competes with
nothing. Leave it on the CPU; a GPU Piper build would buy latency that is
already inside budget, in exchange for a second CUDA dependency to deploy.

### Measurement before scheduling logic

Measure on the real machine:

- Qwen VRAM residency before STT;
- Whisper model-load VRAM;
- peak Whisper VRAM;
- VRAM immediately after process exit;
- GPU transcription latency;
- CPU transcription latency;
- Greek recognition quality;
- English recognition quality;
- model load/unload latency.

Do not build an elaborate scheduler until these numbers are known.

---

## 8. Sidebar microphone — DEFERRED until the phone path has matured

**Status (2026-09-03): not scheduled. Gated, not merely reordered.**

The phone is already a better microphone than anything Forge can build, attached
to a remote path that ships today (Telegram remote control, 0.14.0). It requires
no capture code, no per-platform binary, no device enumeration and no VS Code
webview permission fight. Every line of §8 is work that the phone path makes
unnecessary for the case voice actually serves — being away from the keyboard.

The sidebar microphone therefore has one honest justification left: **hands-free
approval and steering while sitting at the desk** (§8A), not prompt dictation.
At the desk, typing a prompt is faster than speaking one.

**Entry gate.** Do not start §8 until all of the following are true of the phone
path in real daily use, not in a test:

1. Telegram voice → transcript → admission has run for at least two weeks
   without a transcription defect that lost or corrupted a prompt;
2. the transcript-as-draft flow (§9.5) has settled — i.e. it is known whether
   users edit transcripts before sending, because that answers whether a
   composer-based sidebar flow is even the right shape;
3. the Phase 0 backend choice (§6.1) is settled and stable, so the sidebar
   reuses a proven `VoiceIngress`, never a parallel one;
4. spoken approvals (§8A) are shipped and have demonstrated that a desk-side
   hands-free need actually exists.

If gate 4 fails — if nobody reaches for hands-free approval at the desk — §8
should be **cancelled**, not postponed. Building it anyway would be plan momentum,
not a requirement.

Everything below is retained as design work for when the gate opens. It is not a
Phase 2 commitment.

### 8.1 UI behavior

Add a microphone button beside the composer.

Suggested states:

```text
idle -> recording -> stopping -> transcribing -> submitted
```

Interaction:

- first press starts local capture;
- button/pill visibly shows recording state and elapsed time;
- second press stops capture;
- cancel discards the recording;
- after stop, Forge transcribes;
- transcript is submitted as a normal user message only after the STT release barrier.

### 8.2 Do not capture audio in the webview

The webview sends only commands such as:

```text
voice:startRecording
voice:stopRecording
voice:cancelRecording
```

The extension host owns the recorder/helper process.

### 8.3 Phase 1 capture choices

Evaluate in this order:

#### Option A — tiny native capture helper based on whisper.cpp SDL2/common-sdl

Best architectural fit if packaging is acceptable.

Advantages:

- whisper.cpp already has tested SDL2 microphone code;
- default-device handling is already implemented in upstream examples;
- avoids VS Code webview microphone permissions;
- capture helper can output WAV/PCM and exit;
- Whisper itself does not need to load until recording stops.

Preferred refinement: separate **capture** from **transcription** so the Whisper model is not resident while the user is merely speaking.

```text
mic button
 -> capture helper only
 -> stop
 -> WAV ready
 -> whisper-cli starts
 -> transcribe
 -> whisper-cli exits
```

This minimizes STT VRAM residency.

#### Option B — ffmpeg local microphone capture (preferred for Phase 2)

**Promoted above Option A on 2026-09-03.** Forge does not merely "treat ffmpeg as
an optional dependency" — the locating infrastructure is already written and
tested:

- `src/tools/ffmpegLocate.ts` — PATH probing plus a bounded WinGet directory
  walk (`WINGET_MAX_DIRS = 2500`, "the value proven on this machine");
- `video.ffmpeg_path` in `src/config/schema.ts:181` for an explicit override;
- `FfmpegMissingError`, whose message names the exact install command per
  platform — already the shape CLAUDE.md requires of a refusal.

Reuse this rather than adding `voice.capture.helper`. Two further points settle
it: §10's Telegram OGG/Opus → 16 kHz mono WAV step needs ffmpeg **anyway**, so
Phase 1 depends on it regardless; and `-f dshow` on Windows can enumerate input
devices, which is the only genuinely hard part.

Constraints: do not hard-code a microphone device name; enumerate devices and let
the user pick, defaulting to the system default. Extend `FfmpegTools` rather than
adding a second locator — the Single Point of Truth rule applies.

#### Option A′ — native SDL2 capture helper (deferred)

Option A below is the best *architectural* fit and the most expensive item in
this plan: it means building, signing and shipping a new C++ binary per platform,
for the phase this plan explicitly says to do **second**. Defer it to Phase 5 and
only if ffmpeg capture measurably fails.

#### Option C — `whisper-stream` / `whisper-command`

These already prove local microphone capture works. They are useful as prototypes or fallback helpers.

However, they load Whisper while listening. For push-to-talk Forge UX, capture-first/transcribe-second is more VRAM-efficient.

### 8.4 Future optimization

If upstream VS Code eventually permits microphone access in webviews reliably, `MediaRecorder` can become an alternate capture backend. It should not block Phase 1.

---

## 8A. Spoken commands and approvals — the promoted use case

**Added 2026-09-03. Schedule this as Phase 1.5, ahead of any sidebar capture work
and ahead of the full TTS renderer.**

### Why this outranks prompt dictation

The rest of this plan treats voice as a way to *start* a turn. But the moment a
Forge user is actually stuck with their hands unavailable is not the start of a
turn — it is the middle of one, waiting to answer a one-word question:

- the per-action confirmation gate wants approve or deny;
- `ask_user` wants a short answer;
- a running turn needs `/steer` or a stop.

That is a **closed vocabulary of roughly five to ten words**. Closed vocabulary
is the easiest thing an STT system does: near-perfect recognition even on a small
model, no lexicon, no Markdown, no ambiguity, and — critically — the transcript
does not need the §9.5 draft-then-confirm protection, because the approval gate
*is* the confirmation. A misheard "approve" is caught by the fact that the user
is looking at what they approved.

Compare the cost. Prompt dictation needs an open vocabulary, a large model,
technical-term recognition (§6.4), and a review step before an agent acts on it.
Spoken approval needs a five-word grammar and one wire into a bridge that already
exists.

### What it reuses

Nothing new is required on the host side:

- `RemoteApprovalBridge` (`src/remote/RemoteApprovalBridge.ts`) already routes
  approve/deny through `host.addApprovalSink()` and correlates by request id;
- `RemoteQuestionBridge` already carries `ask_user` questions to a remote surface;
- `/steer` already parses via `parseSteerCommand()`
  (`src/remote/RemotePromptAdmission.ts:39`) and re-enters `handle()`;
- Telegram voice notes are already the transport, once §9 lands.

A spoken command is therefore just a transcript that is **matched against a
grammar before prompt admission** and dispatched to the same bridge a button
press would have hit.

### The grammar

Keep it explicitly small and closed. Suggested Phase 1.5 set, English and Greek:

```text
approve   | yes    | ok          -> approval sink: approve
deny      | no     | reject      -> approval sink: deny
stop      | cancel | abort       -> cancel current turn
status                            -> current turn summary
<anything else>                   -> falls through to ordinary prompt admission
```

Rules that keep this safe:

1. **Match whole utterances, never substrings.** "Do not approve that" must not
   match `approve`. This is the substring-guard trap from CLAUDE.md, and it is
   more dangerous here than anywhere else in this plan, because a false match
   *takes an action*. Require the transcript, after trimming and case folding, to
   equal one of the grammar entries — nothing fuzzy, nothing prefix-based.
2. **A spoken command must clear every gate a typed one clears** — owner match,
   private chat, TOTP/session lock, dedup. It is a shortcut through the
   *vocabulary*, never through the auth path (§20).
3. **No match means no special handling.** Fall through to ordinary admission
   with the §9.5 draft behaviour. The grammar never swallows a prompt.
4. **Correlate before authorizing (R1).** An `approve` that cannot be tied to
   exactly one pending request is not an authorization. See §22A/R1-revised for
   the recording-window rule and the reply fallback. This applies to
   `stop`/`cancel` too.
5. **Only match when the corresponding gate is actually open.** "Approve" with no
   pending approval is not an approval — it is a prompt, or an error, and it must
   not be silently dropped. Say so.

### Deliberately not in scope

No wake word. No always-listening capture. No confidence-threshold heuristics or
fuzzy matching. If the grammar does not match exactly, the utterance is a prompt.

---

## 9. Telegram voice input

### 9.1 Extend Telegram schema

Add `message.voice`, including at minimum:

- `file_id`;
- `duration`;
- `mime_type` when provided;
- `file_size` when provided;
- `duration` — load-bearing, not informational: it defines the recording window
  in the R1 correlation rule.

Also add `message.reply_to_message.message_id`. An explicit reply always wins
over the timing heuristic and is the fallback an ambiguous spoken command is told
to use (§22A/R1-revised).

Telegram voice notes should enter Forge as a dedicated audio/voice attachment classification, not as text.

### 9.2 Fix binary attachment handling

Current Forge code converts non-image/non-PDF attachments to UTF-8 strings. That
path is invalid for audio. **Verified 2026-09-03 — the fork exists in three
places, not one, and fixing only the first leaves audio corrupted:**

- `src/remote/TelegramChannel.ts:333` — `downloadAttachment()` returns
  `bytes.toString('utf8')` for anything not `image/*` or `application/pdf`;
- `src/remote/RemoteAttachmentStore.ts:62-65` — the same ternary again on the
  read-back path;
- `src/remote/RemoteAttachmentStore.ts:96-101` — and again on the decode path,
  which then runs `mimeFromHeader(bytes)` validation that an audio media type
  must be taught about.

Fix the **contract**, not the call sites. `RemoteInboundAttachment` currently
encodes "binary vs text" implicitly by sniffing `mediaType` at three separate
boundaries, and a fourth site would guess wrong the same way.

**Decision (2026-09-03, second pass): audio uses a bounded temp-file handle. It
never becomes a string.** The earlier revision offered an explicit `encoding`
field *or* a temp-file reference and called the latter preferred; an
implementation handoff has to pick one, so it is picked here.

```ts
/** Audio never enters `data`. The file is owned by the voice operation. */
interface VoiceAudioHandle {
  path: string;         // temp file, outside the workspace
  bytes: number;        // enforced against voice.input.max_bytes
  mediaType: string;    // 'audio/ogg', 'audio/wav'
  operationId: string;  // owner; cleanup is keyed to it (§20.1)
}
```

Why this and not the encoding field:

- base64 inflation and the 14 MB string cap both stop applying to audio entirely
  — the limit-mismatch bug class disappears rather than being documented around;
- audio never sits in extension-host memory as a string, then again as a Buffer;
- ffmpeg (§10) wants a **path** anyway, and so does `WhisperRunner`. A string
  payload would be decoded to a temp file two steps later regardless — the
  encoded form was never the useful shape.

**Ownership and cleanup are attached to the voice operation, not to a `finally`
block in one caller.** The operation owns every temp file it creates (downloaded
OGG, normalized WAV) and deletes them on every STT terminal path — successful
transcript capture, rejection, refusal, cancellation, and timeout. Once the
complete transcript has been copied into a `PendingVoiceDraft`, the audio files
are no longer useful and must already be gone; they are never retained for the
draft's ten-minute TTL. Draft expiry emits its audit event but has no audio to
clean up. A `VoiceOperation.dispose()` that nothing calls is the `ask_user`
`cancel()` bug again; wire it in the same commit.

The **existing** `RemoteInboundAttachment` still needs its three sites reconciled
for non-audio binaries, but that is now a separate, smaller cleanup — audio no
longer depends on it, so it does not block Phase 1.

**Size limits.** With the temp-file handle above, the 14 MB
`RemoteInboundAttachmentSchema.data` string cap no longer governs audio, and the
`max_bytes: 25000000` conflict in the earlier §18 is resolved by construction.
`voice.input.max_bytes` becomes a straightforward file-size bound (9 MB default —
a Telegram voice note is far smaller; this is a runaway guard, not a target).

Enforce it **twice**: against `file_size`/`duration` from the update payload
*before* `getFile`, so an over-size note costs nothing; and against bytes actually
written, so a lying or absent `file_size` cannot bypass it.

Do not base64 audio unless an existing store boundary specifically requires it.
Prefer bytes/temp-file references internally to avoid needless copies.

### 9.3 Telegram path

```text
Telegram voice
 -> existing owner/private/TOTP/session checks
 -> validate size/duration
 -> getFile
 -> stream response into a bounded temp file (count actual bytes while writing)
 -> VoiceIngress
 -> decode/normalize
 -> whisper.cpp child process
 -> wait for exit
 -> transcript
 -> existing RemotePromptAdmission
```

Do not bypass:

- owner matching;
- private-chat restriction;
- TOTP/session lock;
- deduplication;
- queue semantics;
- `/steer`/current-turn behavior;
- remote audit conventions.

### 9.4 (withdrawn) Telegram text emoji guard

Removed 2026-09-03. See §2.9 — no inbound emoji defect has been observed, the
guard would regress a shipped feature, and it is unrelated to the voice path.
Inbound Telegram text handling is unchanged by this feature.

### 9.5 UX — a transcript is a draft, not a submission

**Revised 2026-09-03. The earlier default (submit immediately, confirmation as an
"optional later mode") is inverted.**

§20 states the reason in its own first line: *voice input is executable intent
after transcription.* And §27.1 measured whisper.cpp appending sentences that
were never spoken — a line repeated four times, a spurious "Thank you." A
hallucinated clause reaching an agent that writes files and runs commands is the
one genuinely dangerous failure in this design, and it costs almost nothing to
close.

Progress, unchanged — use the existing remote progress infrastructure:

```text
Transcribing voice…
```

**Defaults:**

| Surface | Default | Why |
| --- | --- | --- |
| Sidebar (§8, if ever built) | transcript lands in the **composer as editable text** | Zero new UI. The user sees exactly what was heard; Enter is one keystroke. Correcting a misheard word costs seconds; discovering it after the agent edited six files costs a checkpoint restore. |
| Telegram | **echo the transcript, then submit on confirmation** | The user is not at the machine and cannot see what the agent is about to act on. |
| Spoken commands (§8A) | submit immediately | Closed vocabulary, single word, and the action is itself a confirmation gate. |

`voice.input.auto_submit: false` is the default. Setting it to `true` is the
opt-in, and it belongs to the user, not to this plan.

On failure, do not submit empty or interrupted text. Backend-specific marker,
refusal or echo filtering follows §7; do not apply an audio-LLM refusal detector
to whisper output without evidence that the selected backend emits that shape.

### 9.6 `PendingVoiceDraft` — the confirmation state machine

"Echo the transcript, then submit on confirmation" is not implementable as
written. This section makes it so.

**Precedent to copy, not reinvent:** `src/remote/RemotePendingPrompt.ts` already
solves the identical problem for TOTP-held prompts — one held item per chat, a
TTL, memory-only, `hold()` / `take()` / `clear()`. `PendingVoiceDraft` is the
same shape and belongs beside it. Memory-only is correct here too: a window
reload should drop an unconfirmed transcript, not resurrect it against a
workspace that has moved on.

```ts
interface PendingVoiceDraft {
  draftId: string;        // short, user-visible, correlates the reply
  channel: RemoteChannel;
  chatId: string;
  transcript: string;     // exactly what STT produced, never edited in place
  operationId: string;    // ties to the §20.1 audit events
  echoMessageId: string;  // Telegram message to which a correction must reply
  createdAt: number;
}
```

**The draft never holds audio (R8).** `VoiceOperation.dispose()` runs — deleting
the downloaded OGG and the normalized WAV — **before** `PendingVoiceDraft` is
constructed. The constructor accepts transcript text and metadata only; it has no
`VoiceAudioHandle` field, no path, no disposable. This makes the retention rule
structural rather than documented: no confirmation path is *capable* of extending
audio lifetime, because by the time a draft exists there is nothing left to
retain. Enforce it in the type, not in a comment.

**One draft per chat.** A second voice note replaces the first and says so
(`Replaced the previous draft.`). This mirrors `RemotePendingPrompt.hold()`
exactly and removes any need to correlate an ambiguous reply against several
outstanding drafts.

#### Transitions

| Input | Transition |
| --- | --- |
| `/ok` (or the inline **Send** callback carrying `draftId`) | admit `transcript` through `RemotePromptAdmission`, clear draft |
| `/no` (or **Discard**, correlated the same way) | clear draft, no prompt created |
| ordinary text sent as a Telegram reply to `echoMessageId` | **treated as the corrected prompt**: admit that text, clear draft |
| recognized existing remote command | route through its existing handler; leave the draft pending unless the command locks/closes the session |
| unrelated ordinary text that is not a reply | admit as a normal new prompt; reject the old draft as `superseded` so it cannot fire later |
| a second voice note | replace the draft, notify |
| TTL expiry (10 min, matching `RemotePendingPrompt`) | clear silently on next touch; `take()` returns undefined |
| session lock / TOTP challenge | clear the draft — an unconfirmed transcript must not survive a re-auth |

Reply correlation is what distinguishes a correction from a new command or a
new prompt. The user does not have to type a correlation id: Telegram's reply
metadata supplies `echoMessageId`, and inline callbacks carry `draftId`.

#### Disambiguation against §8A spoken commands — the ordering rule

This is the genuine hazard of shipping §8A and §9.5 together. Authentication,
owner/private-chat checks and dedup run first, followed by this strict dispatch
order for every authorized inbound event:

```text
1. tool-approval gate open?      -> exact approve/deny grammar wins
2. recognized remote command?    -> existing handler wins (/steer included)
3. voice draft control/reply?     -> /ok, /no, callback, or correlated correction
4. other §8A grammar match?       -> stop/status action when currently valid
5. otherwise                     -> ordinary admission; supersede stale draft
```

**Correction (R1): "approval gate open?" is not a boolean.** `RemoteApprovalBridge`
holds a `Map` — several approvals can be pending at once. Step 1 above resolves
only when the recording-window correlation in §22A/R1-revised identifies exactly
one, and otherwise refuses and asks for a reply or a tap. The same applies to
`stop`/`cancel`.

**A pending tool approval outranks a pending voice draft.** The approval is
blocking a running turn and the agent is waiting on it; a draft is not blocking
anything. Rationale worth keeping: the cost of a wrong answer is asymmetric — a
mis-routed "approve" could authorise a file write, while a mis-routed "/ok"
merely sends a prompt the user is looking at.

Two consequences that must be implemented, not assumed:

- **The confirm verbs are `/ok` and `/no`, deliberately *not* `yes`/`approve`/`cancel`.**
  Reusing approval vocabulary for draft confirmation is how the two gates collide.
  Slash-prefixed verbs cannot be produced accidentally by a transcript and cannot
  collide with the §8A grammar, which matches bare words only.
- **The echo message states which gate is open**, e.g.
  `Draft [a3f]: "restart the backend" — /ok to send, /no to discard, or just type
  the corrected prompt as a reply to this message.` A gate the user cannot see
  is a gate they will answer wrongly.

#### Inherited, not re-implemented

Owner match, private-chat restriction, TOTP/session state, dedup and rate
limiting all apply to the confirming message exactly as to any other text event.
The draft holds a transcript; it does not hold an authorisation.

---

## 10. Audio normalization

Do not use MP3 as an intermediate format.

Expected inputs:

- Telegram: OGG/Opus;
- local capture helper: ideally already 16-bit mono WAV/PCM.

Target Whisper input for the simple one-shot path:

```text
16 kHz
mono
PCM s16 WAV
```

`whisper-cli` historically expects 16-bit WAV in its simple CLI path, while newer whisper.cpp common decoding/server code can optionally decode additional formats with ffmpeg/miniaudio. Do not depend on a compile-time decoder feature until the pinned build is tested.

Safest Telegram flow:

```text
OGG/Opus -> ffmpeg -> 16 kHz mono WAV -> whisper-cli
```

No lossy OGG -> MP3 -> WAV chain.

Temporary files:

- unique random names;
- outside workspace by default;
- bounded size/duration;
- cleanup after success;
- cleanup after error/cancel;
- never executable;
- no transcript/audio logging unless explicitly enabled.

---

## 11. Piper TTS backend

### 11.1 Phase 3 decision

*(Renumbered 2026-09-03: Piper lands in Phase 3, not Phase 1. "Phase 1" here and
below was residue from the pre-reorder draft.)*

Use Piper as a separate local process/runtime.

Greek voice:

```text
JOY / el_GR-joy-medium
```

English:

```text
configurable Piper voice
```

Run TTS on CPU by default. Its job should not compete with Qwen/Whisper for GPU memory.

### 11.2 Do not make the Piper integration depend on Python

The maintained Piper project supports Python APIs and HTTP server operation, but also provides `libpiper`/C++ tooling in current versions.

For Forge, the abstraction should simply expect an external local Piper command/runtime. The exact installed distribution can be swapped without affecting the speech renderer.

### 11.3 Do not keep spawning Piper once per sentence if latency is poor

Piper documentation notes that CLI startup repeatedly reloads the model and can be slower than a resident server.

Unlike Whisper, Piper is small and CPU-side, so a resident Piper process is acceptable if measurements show startup overhead matters.

Therefore:

- Phase 3 may begin with one-shot CLI simplicity;
- if latency is noticeable, move Piper to a small resident local process/server;
- this does **not** violate the STT release rule because Piper is not occupying the precious Whisper/Qwen GPU budget when configured CPU-only.

---

## 12. Code-aware TTS problem

JOY and normal English Piper voices do not understand programming semantics by themselves.

Problematic examples:

```text
exec_command
llama.cpp
src/tools/execTools.ts
--ctx-size
Qwen3.8
CUDA
VRAM
npm
x8/x8
```

Forge must keep two representations:

```text
assistantOriginalText -> UI/history/Telegram text
assistantSpeechText   -> Piper only
```

Never modify conversation history merely to improve pronunciation.

---

## 12A. Spoken notifications first — build this before the SpeechRenderer

**Added 2026-09-03. This reorders §13-§15 behind a much smaller deliverable.**

§13, §14 and §15 together are the most expensive block in this plan: Markdown
segmentation, identifier and path normalization, a 100-200 entry lexicon, and
espeak phoneme injection — all to make *arbitrary* assistant prose speakable.

But the need voice actually serves is the one §8A already identified: **the user
is away from the screen.** What they need spoken is not the response. It is:

```text
"Done. Three files changed."
"Waiting for approval: write to config.yaml."
"I have a question."
"Failed: type-check errors."
```

That is a **fixed template vocabulary of roughly a dozen phrases**, with a
handful of interpolated numbers and one filename. Its properties are the exact
inverse of §13's:

| | Spoken notifications (§12A) | Full response reading (§13-§15) |
| --- | --- | --- |
| Input | ~12 fixed templates | arbitrary Markdown |
| Pronunciation work | tune each phrase once, by ear, against JOY | lexicon + phonemes + fallback |
| Code-block problem | does not arise | §13's largest subsection |
| Testable | exhaustively | by sampling |
| Wires into | `RemoteNotificationFanout` (exists) | new renderer |

**Ship §12A as Phase 3a and let it answer whether §13 is wanted at all.** It is
plausible that spoken *status* is the whole feature and spoken *responses* are
something nobody turns on twice — you read code, you do not listen to it. That
question is cheap to answer empirically and expensive to answer by building §13
first.

Interpolated values still need care, and they are the only real work here:
filenames get the §13.1 path rule (read useful components, not the full path),
counts get number-to-words. Both are a few lines, not a subsystem.

If §12A ships and users then ask for full response reading, §13-§15 are waiting
below, unchanged, and now with a proven Piper integration underneath them.

---

## 13. SpeechRenderer

**Scheduling note (2026-09-03): gated behind §12A.** Do not start this section
until spoken notifications have shipped and demonstrated demand for reading full
responses aloud.

Normal operation must be deterministic code, not a second LLM call.

Pipeline:

```text
assistant Markdown
 -> Markdown-aware segmentation
 -> Phase 1 emoji removal from speech copy
 -> code-block policy
 -> inline-code normalization
 -> identifier/path/version/unit normalization
 -> technical pronunciation lexicon
 -> raw Piper phoneme injection when available
 -> final TTS string
```

### Generic deterministic rules

Implement rules before growing a huge dictionary:

- strip emoji from the speech-only copy in Phase 1;
- `snake_case` -> split words;
- `camelCase` -> split words;
- `PascalCase` -> split words;
- common all-caps acronyms -> spelled/pronounced using language rules;
- numbers + units -> speak naturally;
- semantic model versions -> e.g. `Qwen3.8`;
- file extensions -> language-specific readable names;
- CLI flags -> strip punctuation and verbalize semantic name where known;
- paths -> shorten/read by useful components;
- URLs -> do not read literally by default;
- hashes -> announce/shorten rather than spell every character;
- Markdown punctuation -> never read formatting marks.

### Code blocks

Default:

```text
speak_code_blocks: false
```

Do not read long source code character-by-character.

Deterministic fallback examples:

```text
"I included a TypeScript code block."
"I included a shell command."
```

Optional future mode may ask an LLM for a spoken summary of very large code sections, but not in Phase 1.

---

## 14. Pronunciation lexicon

Do not start with 1,000 hand-written entries.

Start with:

- roughly 100-200 common coding/AI terms;
- generic token-class rules;
- add entries from real failed pronunciations;
- allow workspace/user override.

Conceptual schema:

```json
{
  "CUDA": {
    "el_text": "κούντα",
    "en_text": "cuda",
    "el_phonemes": "",
    "en_phonemes": ""
  },
  "Qwen": {
    "el_text": "κουέν",
    "en_text": "quen",
    "el_phonemes": "",
    "en_phonemes": ""
  },
  "VRAM": {
    "el_text": "βι ραμ",
    "en_text": "vee ram"
  },
  "npm": {
    "el_text": "εν πι εμ",
    "en_text": "N P M"
  }
}
```

Store text fallback and optional raw phonemes in the same entry.

---

## 15. Piper raw-phoneme injection

Current maintained Piper supports raw espeak-ng phonemes in normal text using:

```text
[[ <phonemes> ]]
```

Example from Piper docs:

```text
I am the [[ bˈætmæn ]]
```

This gives Forge a clean pronunciation override without retraining JOY.

Conceptual speech-only string:

```text
Restart [[ <CUDA phonemes> ]] and check the backend.
```

### MEASURED 2026-09-03 — `[[ ]]` is NOT available on the shipped runtime

Step 1 of the strategy below ("pin the runtime being tested") is what settled
this, and it settled it against the section. On piper **1.2.0** — the last
standalone Windows binary rhasspy ever released, Nov 2023, and the one this
machine runs — the escape is not parsed at all:

```
input : I am the [[ bˈætmæn ]]
piper : aɪɐm ðə bˈiː stɹˈɛs ɐ ˈiː tˈiː ˈɛm ɐ ˈiː ˈɛn
```

It phonemized the *characters of the phoneme string*: `b`, then the `ˈ` stress
mark read as the **word "stress"**, then `a`, `e`, `t`, `m`, `a`, `e`, `n`. So
the failure is not a silent no-op that falls back to text — it is actively
worse than writing nothing, which makes shipping an entry with a phoneme field
a hazard rather than an optimization.

The feature is real, but it belongs to **piper1-gpl v1.7.0**, whose Windows
release is a **Python wheel only** (`piper_tts-1.7.0-cp39-abi3-win_amd64.whl`).
There is no standalone `piper.exe` in it. Adopting it therefore collides with
§11.2 ("do not make the Piper integration depend on Python"), which is a
deployment constraint, not a preference — the same one that ruled out
faster-whisper in §6.1b. That trade is the user's to make and has not been
made; Python 3.10 and 3.11 are both present on this machine, so it is
available whenever it is wanted.

**Consequence for §14:** the lexicon ships text-transliteration only. The
`el_phonemes` / `en_phonemes` fields stay in the entry schema and stay empty,
and nothing reads them. That is the plan's own advice ("keep text fallback
available") arrived at from the other direction.

### Can we build our own `piper.exe`? — traced 2026-09-03

Asked because a homemade native binary would sidestep the Python wheel. The
answer is yes, and it would not help, which is only obvious once you know where
the feature lives:

```
src/piper/voice.py:255      if text_part.startswith("[["):
libpiper/src/piper.cpp      (no match)
```

**`[[ ]]` is parsed in piper1-gpl's PYTHON layer**, not in `libpiper`. It is
text splitting performed *before* anything reaches the C++ synthesizer.
`libpiper/src/main/main.cpp` is a real native CLI target and does build with
CMake — but compiling it produces a binary with exactly the pronunciation
control 1.2.0 already has, which is none. **Do not spend a day on a native
build expecting to get phonemes out of it.**

Nor is there a side door in 1.2.0. Its `--json-input` mode ignores a `phonemes`
field entirely; the debug trace shows it phonemizing the raw text regardless.
That binary has no phoneme entry point at all.

Two routes do work, neither yet justified:

1. **Freeze the wheel.** PyInstaller `--onefile` on piper1-gpl yields a genuinely
   self-contained `piper.exe` with the interpreter inside and nothing for a user
   to install. That satisfies §11.2 at the level the rule cares about --
   deployment -- even though Python is technically bundled. Cost is size: 150-250
   MB against the current 500 KB, because onnxruntime and espeak-ng data ride
   along.
2. **Skip Piper entirely and go to espeak-ng.** The 1.2.0 install already ships
   `espeak-ng-data/` with **113 compiled dictionaries**, `en_dict` and `el_dict`
   among them. espeak is what does the phonemizing, so a dictionary entry fixes a
   word for the *existing* binary -- no new build, no Python, no version change.
   It is the same mechanism `[[ ]]` exists to reach, entered through the front
   door. The catch is that compiling a dictionary needs the `espeak-ng` CLI (only
   the DLL ships with Piper; the CLI is not on this machine) and means shipping
   modified data files.

**Trigger for revisiting: evidence, not appetite.** Phonemes only buy something
for words where no *spelling* produces the right sound, and that list does not
exist yet -- §14's transliteration covers every term measured so far. Collect
the terms that still come out wrong after transliteration during real use. A
short list means more lexicon entries. A long list, especially of Greek-script
words, is what makes route 2 worth its complexity.

### Implementation strategy

1. Pin the Piper runtime/version being tested.
2. Build a tiny standalone JOY acceptance test.
3. Test 10-20 terms first:
   - CUDA
   - Qwen
   - GitHub
   - Python
   - TypeScript
   - JavaScript
   - llama.cpp
   - npm
   - VRAM
   - NVIDIA
   - JSON
   - YAML
   - API
   - HTTP
   - backend
   - context
4. Generate/test correct Greek and English phoneme strings.
5. Compare raw-phoneme output with text-transliteration fallback.
6. Only then expand the lexicon.

### Important limitation

Raw phonemes do not magically expand the voice model's learned acoustic capabilities. A voice can still render some unusual phoneme sequences poorly. Keep text fallback available.

Every shipped pronunciation entry should be testable against the selected voice/runtime.

---

## 16. Greek + English behavior

### STT

Use a multilingual Whisper model.

Default:

```text
language: auto
```

Debug overrides:

```text
language: el
language: en
```

### TTS

Phase 1:

- detect dominant assistant-response language;
- Greek-dominant -> JOY;
- English-dominant -> configured English Piper voice;
- technical terms -> lexicon + raw phonemes/text fallback;
- emoji -> remove from speech-only copy;
- avoid switching voices every few words.

Later:

- language-segmented synthesis and PCM concatenation if real usage proves it worthwhile.

---

## 17. Voice output routing

Text should always remain available.

Suggested settings:

```yaml
voice:
  output:
    sidebar: off | on
    telegram: text | text_and_notification | text_and_voice
```

Recommended default:

```text
sidebar: off
telegram: text_and_notification    # §12A spoken status only, not the response
```

`text_and_notification` is the Phase 3a shape and the one most likely to survive
contact with real use: full text as always, plus a short spoken *"done, three
files changed"*. `text_and_voice` reads the whole response aloud and depends on
Phase 4.

Users explicitly opt into spoken responses.

**`voice` (voice-only) is removed from the Telegram options.** It contradicted
this section's own first line — *text should always remain available* — and there
is no second guaranteed surface to fall back on when the user is remote and away
from the machine. A synthesis failure under voice-only would leave them with
nothing at all, which §24 already forbids (*"Piper failure does not lose textual
response"*). The remaining options all keep the full text:

```text
text                   full text only
text_and_notification  full text + a short spoken status (§12A)   [default]
text_and_voice         full text + the response read aloud (Phase 4)
```

If a voice-only mode is ever genuinely wanted, it needs an explicit answer to
"where does the text go when synthesis fails", and that answer is not in this
plan.

For Telegram, if sending a native voice note requires Opus/Ogg, convert the locally synthesized WAV to the Bot API's preferred voice-note format only at the transport boundary. Do not change Piper's internal output format just for Telegram.

---

## 18. Proposed config

Illustrative only; follow current Forge schema conventions.

```yaml
voice:
  enabled: true

  # Every capability is INDEPENDENTLY opt-in (R6). `enabled: false` is a kill
  # switch, but `enabled: true` must never turn anything on by itself — a
  # failure has to be attributable to one capability, and rollout is staged.
  input:
    telegram: true        # the only capability on by default
    commands: false       # §8A — spoken approve/deny/stop; ships after R5
    sidebar: false        # §8 — deferred, gated, possibly cancelled
    auto_submit: false    # §9.5 — a transcript is a draft, not a submission
    max_seconds: 180
    # Bounds the temp-file handle (§9.2); audio never becomes a string, so the
    # 14 MB RemoteInboundAttachmentSchema.data cap does not apply to it.
    max_bytes: 9000000

  capture:
    backend: ffmpeg       # ffmpeg | helper | future-webview  (§8.3)
    device: ''            # empty = system default; never hard-code a device name
    # ffmpeg itself is located by src/tools/ffmpegLocate.ts and overridden by
    # the EXISTING `video.ffmpeg_path` key. Do not add a second ffmpeg path.

  stt:
    # Example A: whisper.cpp. Phase 0 decides the shipped recommendation.
    backend: whisper_cpp
    binary: C:/path/to/whisper-cli.exe
    model: C:/path/to/ggml-large-v3.bin
    language: auto
    initial_prompt: ''        # decoding bias for rare technical terms (§6.4)
    device: cpu               # cpu | gpu; explicit, never a preference/fallback
    # gpu_device: 0           # required only when device: gpu
    # flash_attn: true        # valid only when device: gpu

  tts:
    enabled: false
    backend: piper
    binary: C:/path/to/piper.exe
    greek_voice: C:/path/to/el_GR-joy-medium.onnx
    english_voice: C:/path/to/en_US-voice.onnx
    language: auto
    speak_code_blocks: false
    strip_emoji: true
    notifications_only: true   # §12A — fixed templates; no §13 renderer yet
    pronunciation_file: .forge/tts-pronunciations.json

  output:
    notifications: false  # §12A — spoken status; separately opt-in (R6)
    responses: false      # Phase 4 — full narration; separately opt-in (R6)
    sidebar: off
    telegram: text
```

The alternative faster-whisper branch of the discriminated config is:

```yaml
voice:
  stt:
    backend: faster_whisper
    python: C:/path/to/python.exe
    model: C:/path/to/local/faster-whisper-large-v3-snapshot
    language: auto
    initial_prompt: ''
    device: cpu               # the only Phase 1 value for this backend
```

Implement `voice.stt` as a Zod discriminated union. Require the executable and
model fields belonging to the selected backend and reject fields from the other
branch; do not silently discover Python, change device, download a model, or
fall back to another backend. Defaults are appropriate only for harmless policy
choices such as `language: auto`, never for executable paths or runtime changes.

---

## 19. Cancellation and concurrency

Voice has several asynchronous stages. Treat capture through completed-text
dispatch as one cancellable `VoiceOperation`:

```text
recording
 -> decoding
 -> STT
 -> release
 -> command dispatch, draft creation, or direct admission
```

If cancelled before completed-text dispatch:

- terminate capture helper;
- terminate Whisper process;
- wait for process exit;
- remove temp files;
- do not create a user message.

After a draft is created, the process/audio operation is already disposed and
only the text-only `PendingVoiceDraft` remains. Discard, supersession, expiry or
session lock closes that draft and emits its terminal audit event; none of those
paths owns a child process or audio file.

Serialize Phase 1 transcription through a small `VoiceTranscriptionQueue`,
including two simultaneous Telegram notes. This is mandatory for GPU and a
conservative default for CPU; permit measured CPU parallelism later without
changing callers. If sidebar capture ever ships, it joins the same queue.

After transcript admission, normal Forge queue/steer behavior takes over.

---

## 20. Security and privacy

Voice input is executable intent after transcription, so preserve every existing Forge control boundary.

Requirements:

- Telegram voice must pass existing remote authentication/session gates;
- voice must not bypass Clanker/approval semantics;
- transcript is treated exactly like typed user input after admission;
- audio size and duration are bounded;
- decoder paths receive fixed argv, never shell-interpolated filenames;
- temp files are not written to workspace by default;
- no automatic retention of recordings;
- no hidden cloud transcription/TTS calls;
- config must make local executable/model paths explicit;
- remote voice duplicates must inherit existing Telegram deduplication semantics.

### 20.1 Voice turns must be forensically legible in the session log

**Added 2026-09-03. This is a requirement, not a nicety.**

CLAUDE.md's rule: *anything written to the session log is the only forensic
record.* Reasoning on `tool_calls` turns was dropped from the log until 0.12.47,
and every behaviour it would have explained is permanently undiagnosable. Voice
introduces a new and worse version of that gap — the user's actual input is
**audio that Forge deliberately does not retain**, so if the transcript is not
logged, a voice turn's true origin is gone the instant it completes.

Six weeks from now, "the agent did something I never asked for" must be
answerable. Without this it reads as a model defect forever, when the real cause
was a hallucinated trailing clause (§27.1) — exactly the misattribution the
tool-audit history in CLAUDE.md warns about.

#### Three events, not fields on a turn that may never exist

The earlier revision put voice metadata on the user turn, then also required
logging notes rejected for size, silence, refusal, corruption or cancellation.
Those contradict: a rejected voice note **produces no user turn to hang fields
on**, and it is the case most worth finding later.

Emit three row types into the session JSONL under `~/.forge/sessions/`, all
carrying the same `operation_id` — the same id that owns the temp files (§9.2)
and the draft (§9.6), so one grep reconstructs the whole operation:

```jsonc
// 1. every voice note, the moment it is accepted for processing
{"type":"voice_ingress_started","operation_id":"v_7f3a","ts_ms":1756900000000,
 "surface":"telegram",            // telegram | sidebar | command
 "audio_ms":3120,"bytes":8431,"media_type":"audio/ogg"}

// 2. terminal failure — NO user turn follows this row
{"type":"voice_ingress_rejected","operation_id":"v_7f3a","ts_ms":1756900001200,
 "reason":"refusal",              // oversize | too_long | decode_failed |
                                  // stt_failed | empty | refusal | echo |
                                  // cancelled | draft_expired | superseded
 "detail":"looksLikeTranscriptionRefusal matched",
 "backend":"whisper.cpp","transcribe_ms":890}

// 3. terminal success — a user turn follows, and shares this operation_id
{"type":"voice_prompt_admitted","operation_id":"v_7f3a","ts_ms":1756900002000,
 "backend":"whisper.cpp","model":"large-v3","device":"cpu",
 "language_detected":"el","audio_ms":3120,"transcribe_ms":890,
 "transcript":"restart the back end", // exact STT output before correction
 "bias_prompt_used":true,          // §6.4
 "auto_submitted":false,           // §9.5
 "edited_before_submit":true,      // did the user change it (§9.6)
 "grammar_match":null}             // §8A command matched, or null
```

Rules:

- **exactly one terminal row per operation** — `rejected` or `admitted`, never
  both, never neither. An operation with a `started` row and no terminal row is
  itself a bug worth being able to detect;
- `voice_prompt_admitted.transcript` is the exact STT output before user edits;
  the following user turn contains the exact text actually admitted. When they
  differ, `edited_before_submit` is true. Both are required: without the first,
  STT quality cannot be diagnosed; without the second, the agent's real prompt
  is lost. On the rejected path, log the transcript in `detail` only for the
  `empty`/`refusal`/`echo` reasons, where the text is the evidence;
- **never log audio**, and never log a path to a file that has been deleted;
- `edited_before_submit` stays the most valuable field: a free, continuous
  measurement of real-world STT accuracy from ordinary use, and the thing that
  tells you whether §6.4's bias prompt or a backend swap actually helped.

**Dedupe before counting any of this**, per CLAUDE.md — session files written
before 0.13.20 re-append on reload, and the first failure rates read off an
un-deduped file were inflated sevenfold.

---

## 21. Licensing/package boundary

### Whisper

Use the upstream `whisper.cpp` license and attribution requirements appropriate to the pinned distribution.

### JOY Greek voice — CC BY-NC 4.0 (the harder blocker)

**This is a separate and stricter constraint than the Piper runtime licence
below, and it is the one that actually forecloses distribution.**

`el_GR-joy-medium` is licensed **CC BY-NC 4.0 — NonCommercial** (§27.4,
`Gemma4GR/VOICE_CARD.md`). VS Code Marketplace distribution is not compatible
with an NC clause, and no choice of Piper runtime changes that. Therefore:

- **never bundle the JOY model** (`.onnx` / `.onnx.json`) in the VSIX, in the
  repo, or in any release artifact;
- JOY is a **user-supplied local file**, referenced by absolute path in
  `voice.tts.greek_voice`, exactly like a GGUF;
- when JOY is the selected voice, Forge must surface the attribution string:
  *"JOY Greek voice (el_GR-joy-medium), Gemma4GR project —
  https://github.com/Efs-O/Gemma4GR, CC BY-NC 4.0"*;
- document the voice licence independently of the runtime licence — they are two
  decisions with two different answers;
- commercial use requires contacting the voice author. Do not assume the shared
  authorship of Forge and Gemma4GR waives this for downstream users: the licence
  binds whoever installs Forge, not just the author.

Note the practical corollary from §27.4: every pre-existing community Greek Piper
voice was trained on synthetic or low-quality data and is unusable. For Greek TTS
there is effectively one option, and it is NC. A permissively licensed Greek
voice would have to be trained, which §22 rules out for Phase 1.

### Piper runtime — GPL-3.0

The maintained OHF Piper repository is GPL-3.0.

For Phase 1:

- treat Piper as an optional external local executable/runtime;
- do not statically/dynamically link `libpiper` into the Apache-2.0 Forge extension without an explicit licensing decision;
- do not bundle the maintained Piper runtime into Forge Marketplace packaging by accident;
- the JOY voice/model license must also be documented independently from the runtime license.

This keeps implementation work moving without creating a distribution-policy surprise later.

---

## 22. What not to build initially

Do not start with:

- direct audio input to Qwen;
- a second voice-specific agent loop;
- a resident Whisper server;
- a native Node Whisper addon;
- webview `getUserMedia` as the only microphone path;
- automatic Qwen unload/reload scheduling;
- 1,000 pronunciation entries;
- word-by-word Greek/English Piper switching;
- an LLM TTS rewrite call for every response;
- emoji-to-speech semantics;
- a wake word or always-listening capture (§8A);
- fuzzy or confidence-threshold matching for spoken commands — exact whole
  utterance or it is a prompt (§8A);
- a sidebar capture helper before the §8 gate opens;
- the full `SpeechRenderer` before spoken notifications have proven demand (§12A);
- retraining JOY merely for code vocabulary;
- embedding `libpiper` into Forge before licensing is settled.

---

## 22A. Pre-implementation review recommendations

**Status: proposed for review, not yet assumed as approved implementation
policy.** Resolve these ten recommendations before starting the concrete STT
runner. They narrow safety and product scope without changing the central
architecture.

### R1. Correlate spoken approval with the approval request

Exact whole-utterance matching (§8A) prevents substring mistakes, but the word
`approve` can still arrive late or refer to a different request. A spoken
approve/deny action should be accepted only when all of these hold:

- the corresponding approval gate is currently open;
- the Telegram voice message is a reply to the approval message, or otherwise
  carries the bridge's request id through transport metadata;
- owner/private-chat/TOTP/dedup checks have already passed.

An uncorrelated `approve` is never authorization. It should receive a concise
instruction to reply to the pending approval message. This is deliberately
stricter than the current §9.6 precedence rule and should be decided before
Phase 1.5.

### R2. Give the Phase 0 bake-off pass/fail thresholds

Do not choose a backend through an undefined "close enough." Record thresholds
before running the corpus, including:

- complete-command accuracy and critical-token accuracy, not WER alone;
- preservation of filenames, identifiers, numbers and negation;
- zero false approve/deny classifications on the safety corpus (R3);
- total WAV-ready-to-transcript wall time, including process/model load;
- peak VRAM and proof that the coding model stays resident;
- installation, diagnostics and packaging burden.

Proposed decision bias: select CPU whisper.cpp unless faster-whisper delivers a
material accuracy improvement on the real Greek/English command corpus. The
extra Python contract is justified by a user-visible accuracy gain, not a
marginal benchmark win. Phase 0 must replace "material" with an explicit numeric
threshold before measuring, so the threshold cannot be moved after seeing the
results.

### R3. Add a dedicated negation and authorization corpus

Average transcription accuracy does not measure the most expensive mistakes.
Include paired English and Greek examples covering at least:

```text
approve                    do not approve
cancel                     do not cancel
stop                       stop after this finishes
yes                        I said no, not yes
keep                       undo
read                       write
```

Add quiet speech, background noise and delayed/replayed voice notes. Score the
recognized text and the resulting grammar action separately: an imperfect
transcript must still produce zero false authorization actions.

### R4. Build the state and lifecycle path against the fake runner first

Before integrating a real model, complete and test:

- `VoiceOperation` ownership and disposal;
- `PendingVoiceDraft` transitions and reply correlation;
- deduplication and the transcription queue;
- exactly-one-terminal-row audit behavior;
- auth/session invalidation;
- cancellation and every temp-file cleanup path.

Use the Tier A fake runner (§24). This separates deterministic correctness bugs
from model, Python, CUDA, ffmpeg and process-startup failures.

### R5. Keep the first production slice narrower than Phase 1.5

The first live slice should be only:

```text
Telegram voice
 -> bounded temporary file
 -> normalization
 -> STT
 -> immediate audio deletion
 -> transcript echo
 -> Send / Discard / reply with correction
```

Run this in daily use before enabling spoken approvals. Phase 1.5 is small in
code but higher in consequence: dictation drafts text; approval authorizes an
action.

### R6. Feature-flag capabilities independently

Do not make one `voice.enabled` switch activate every capability. Proposed
independent policy gates:

```yaml
voice:
  input:
    telegram: true
    commands: false
    sidebar: false
  output:
    notifications: false
    responses: false
```

The schema may retain a top-level kill switch, but commands, notifications and
full-response speech must remain separately opt-in. This supports staged rollout
and makes failures attributable to one capability.

### R7. Tune silence trimming conservatively

`silenceremove` can prevent trailing hallucination and also clip real quiet
speech. Phase 0 must test several microphones, background-noise levels, quiet
utterances, and soft initial/final consonants in both languages. Record the
chosen threshold and minimum-silence values with the benchmark result. Prefer
retaining harmless extra silence over deleting a real word; the draft-confirm
gate remains the final protection against appended text.

### R8. Enforce audio lifetime in the types

After STT succeeds, dispose `VoiceOperation` before constructing
`PendingVoiceDraft`. The draft constructor accepts transcript text and metadata,
never a `VoiceAudioHandle`, file path or disposable. This makes the privacy rule
structural: no draft or confirmation path is capable of extending audio
retention accidentally.

### R9. Add semantic acceptance assertions

Tier B should score more than transcript similarity. Assert explicitly that:

- negation survives;
- filenames and identifiers remain distinguishable;
- numbers and model versions remain correct;
- `read` is not changed to `write`;
- `keep` is not changed to `undo`;
- English technical tokens survive inside Greek sentences.

Store the expected semantic fields beside each fixture so backend swaps can be
compared deterministically without relying only on subjective listening.

### R10. Do not let TTS gate the useful release

Phase 1 Telegram STT and the draft-confirm workflow are the product milestone.
Piper validation may run independently, but Piper integration, notification
speech, full response narration and pronunciation dictionaries do not block the
STT release. Preserve the existing order: short fixed notifications first, then
measure demand before building arbitrary Markdown narration.

### Review outcome — recorded 2026-09-03

| # | Verdict | Rationale |
| --- | --- | --- |
| R1 | **revised** | Principle accepted and it is stronger than stated — but the reply-to mechanism removes the hands-free property that justified §8A at all. Counter-proposal below. |
| R2 | **accepted**, with a starting number | Pre-registration is right; "define a threshold later" is the same deferral it diagnoses. Numbers proposed below. |
| R3 | **accepted** | The highest-value item here. Folded into §24 as its own corpus. |
| R4 | **accepted** | Sharpens §24's tiering into a sequencing rule. Folded into §23 Phase 1. |
| R5 | **accepted** | Folded into §23 as Phase 1 / Phase 1.5 gating. |
| R6 | **accepted** | §18 already contradicted it (`commands: true`). Fixed. |
| R7 | **accepted** | Correctly walks back "mandatory trimming" to "mandatory, conservatively tuned". Folded into §24. |
| R8 | **accepted** | Best item in the list: makes the privacy rule structural rather than documented. Folded into §9.2 and §9.6. |
| R9 | **accepted** | Folded into §24 Tier B alongside R3. |
| R10 | **accepted** | Already the plan's shape; now pinned in §25 so it cannot drift back. |

### R1 revised — correlate, but do not require a reply gesture

**The review understates its own case, and the code proves it.** In
`src/remote/RemoteApprovalBridge.ts:63-81` the *button* path correlates three
ways: `actionId`, `chatId`, and a `nonce`, and refuses if any mismatches. A
spoken `approve` carries **none** of them. Worse, `approvals` is a `Map` —
`resolveAction()` searches it — so **multiple approvals can be pending at once**.
The §9.6 precedence rule assumed a single open gate, and that assumption is
wrong.

**But applied as written, R1 removes the reason §8A exists.** If the user must
long-press the approval message and hold to record a reply, they are already
holding the phone with the message on screen — where the existing inline
**Approve** button is *one tap*. Reply-then-speak is strictly more gestures than
the button it would replace. R1 as written does not make spoken approval safe; it
makes it pointless.

**Counter-proposal — correlate by recording window:**

Accept a spoken approve/deny only when **all** hold:

1. owner / private-chat / TOTP / dedup checks passed (unchanged);
2. **exactly one approval was pending for the entire recording window**, and it
   is still pending and unresolved;
3. the recording window is derived as `[message.date - voice.duration,
   message.date]` from the update payload;
4. the resolved approval's `chatId` matches, exactly as the button path requires.

If two approvals were open, or one opened or resolved inside the window, **refuse
and ask for a reply or a tap** — naming the pending request. The ambiguous case
is where R1's strictness belongs; the unambiguous case keeps hands-free.

Also add `reply_to_message.message_id` to the Telegram schema and honour it when
present: an explicit reply always wins over the timing heuristic, and is the
fallback the refusal message points to.

**Honesty about what this is.** The timing check is a **race-condition guard, not
a security boundary.** `message.date` is Telegram's clock and `duration` is
client-reported; neither is trustworthy against an adversary. That is acceptable
here *only* because the sender is already owner-authenticated and TOTP-gated
before this point — the thing being prevented is a late "approve" landing on the
wrong request, not an attacker forging one. Do not let this mechanism drift into
carrying authentication weight.

**Apply the same rule to `stop`/`cancel`**, which R1 does not mention. A late
"stop" cancelling a turn the user did not mean to cancel is the same race with a
cheaper but still real cost.

### R2 accepted — with opening thresholds, to be fixed before measuring

Proposed starting values, to be argued down or up **before** the corpus runs and
frozen thereafter:

- **false authorization actions on the R3 corpus: exactly 0.** Not a threshold —
  a gate. Any backend that produces one is disqualified regardless of accuracy.
- **complete-command accuracy ≥ 95%** on the Greek and English command sets
  (the whole utterance usable as a prompt, not per-token WER).
- **critical-token accuracy ≥ 98%** for negation, filenames, identifiers and
  numbers (R9's fields).
- **wall-clock WAV-ready → transcript ≤ 3 s** for a 5-second utterance,
  including process and model load.
- **faster-whisper must beat CPU whisper.cpp by ≥ 3 percentage points** of
  complete-command accuracy to justify its Python contract (§6.1). Below that,
  packaging wins.

The last number is the one R2 was really asking for: it converts "material
improvement" into something that cannot be renegotiated after the results are in.

---

## 23. Fastest implementation path

### Phase 0 — standalone validation before touching agent logic

1. **Head-to-head STT bake-off (§6.1) — this is the decision Phase 0 exists to
   make.** Compare all three independent engine/device candidates: CPU
   `whisper.cpp large-v3`, CPU `faster-whisper large-v3` (already installed,
   §27.1), and GPU `whisper.cpp large-v3` (already built at
   `N:/AI/Tools/whisper.cpp/build/bin/Release/whisper-cli.exe`). Production
   runner code and config defaults wait for a winner; the backend-neutral work
   explicitly listed in §6.1 may proceed alongside the bake-off.
2. Re-benchmark `large-v3-turbo` on **short command utterances** before letting
   it near a default — it was deleted here for hallucinating on long audio
   (§27.1). Quantized turbo only if that clears.
3. Record 15-20 short Greek coding commands and 15-20 English coding commands.
4. Measure, for each candidate: WER/subjective command accuracy, and **total
   wall-clock from WAV-ready to transcript including model load** — not inference
   time. A 3-second command is dominated by load.
5. Measure VRAM before load, peak, and after child-process exit. Expect the CPU
   candidate to be flat zero; confirm it, because that is its whole argument.
6. Confirm the coding model stays resident and warm throughout — a GPU win that
   evicts Qwen is not a win (§7).
7. Pin/test Piper runtime with JOY.
8. Test Piper `[[ raw phoneme ]]` syntax with JOY.
9. Build a 15-term technical pronunciation sample set.
10. Confirm one-shot Piper startup latency.

### Phase 1 — Telegram STT

Telegram is the easiest end-to-end input because the phone already records the
microphone. It is also, after the 2026-09-03 revision, the **only** input path
scheduled — see §8.

1. Extend `TelegramUpdateSchema` with `voice`.
2. Add the bounded `VoiceAudioHandle` path (§9.2). Do not couple Phase 1 to the
   separate non-audio `RemoteInboundAttachment` cleanup.
3. Apply the independent `voice.input.max_bytes` file limit (§9.2).
4. Stream OGG/Opus into the bounded temp file; reject over-size **before**
   `getFile` when metadata is present and abort the stream when actual bytes
   cross the limit.
5. Normalize to WAV via `ffmpegLocate` (§10).
6. Spawn the Phase 0-selected STT backend through `VoiceIngress`, whose entry
   point takes a **file path** (§5) — check in the fixtures with it.
7. Wait for exit; delete temp audio.
8. Apply only the selected backend's proven marker/filter rules (§7); never
   admit empty or interrupted output.
9. Implement `PendingVoiceDraft` (§9.6) beside `RemotePendingPrompt`, with the
   `/ok` `/no` verbs and the approval-outranks-draft precedence rule.
10. Trim leading/trailing silence in the normalize step (§24) — mandatory, one
    ffmpeg filter argument.
11. Add `Transcribing voice…` progress.
12. Emit the three §20.1 audit events. **Same commit** — a voice turn that
    shipped before logging did is a turn nobody can ever explain.
13. Wire `VoiceOperation.dispose()` so temp files die immediately after STT
    reaches a terminal path, before a pending draft waits for confirmation.
14. Tier A tests against the fake runner (§24), including the failure shapes.

**Build order within Phase 1 (R4): the fake runner comes first.** Complete and
test `VoiceOperation` ownership and disposal, `PendingVoiceDraft` transitions,
dedup and the transcription queue, exactly-one-terminal-row auditing, auth and
session invalidation, cancellation and every temp-file cleanup path — **all
against the Tier A fake** — before a real model, Python, CUDA or ffmpeg is in the
picture. This separates deterministic state bugs from process-startup and model
failures, which is the difference between a one-hour fix and the kind of
multi-day misattribution the CLAUDE.md tool audits describe.

**Ship this and live on it before Phase 1.5 (R5).** The first production slice is
dictation only:

```text
Telegram voice -> bounded temp file -> normalize -> STT
              -> immediate audio deletion -> transcript echo
              -> Send / Discard / reply with correction
```

Run it in real daily use before enabling `voice.input.commands`. The asymmetry is
the whole argument: **dictation drafts text, approval authorizes an action.**
Phase 1.5 is small in code and large in consequence.

This validates the entire STT/prompt pipeline without solving local audio capture
at the same time.

### Phase 1.5 — spoken commands and approvals (§8A)

**Entry gate (R5):** Phase 1 dictation has run in real daily use first, and
`voice.input.commands` stays `false` until it has (R6). **Do not start this while
Phase 1 is still settling.**

The highest value-to-effort item in this plan — and the highest-consequence. Closed five-word grammar, matched
whole-utterance only, dispatched to bridges that already exist.

0. Build the R3 safety corpus and prove zero false authorization actions on the
   selected backend **before** wiring the grammar to anything that acts.
1. Define the grammar (EN + EL) as data, not scattered conditionals.
2. Match after trimming and case folding, **whole utterance only** — never a
   substring, never a prefix, never fuzzy.
3. Implement the R1-revised recording-window correlation, including the
   ambiguous-case refusal and the `reply_to_message` fallback.
4. Dispatch approve/deny to `RemoteApprovalBridge`'s existing sink — never
   without a correlated request.
5. Dispatch stop/cancel to the existing turn cancellation — same correlation
   rule; a late "stop" cancelling the wrong turn is the same race (§22A/R1).
6. Route `/steer` through `parseSteerCommand()` unchanged.
7. Match only while the corresponding gate is open; otherwise fall through to
   ordinary admission.
8. Log `grammar_match` on every voice turn (§20.1).
9. Test the near-misses: "do not approve that" must not approve.

### Phase 2 — (was sidebar microphone) DEFERRED / possibly cancelled

Gated behind the four conditions in §8, one of which is *"spoken approvals have
demonstrated that a desk-side hands-free need actually exists."* If Phase 1.5
ships and nobody reaches for it at the desk, cancel this rather than postpone it.

### Phase 3 — Piper integration, minimal

1. Add the `PiperRunner` external-process abstraction — **both CLI dialects**
   (`--output-raw` stdout PCM with a caller-built WAV header, and
   `--output_file`), ported from `Gemma4kids/src/main/ttsMain.ts` (§27.3).
2. `scanVoices()` / `selectVoice()` from the same source.
3. JOY Greek output from a **user-supplied** voice file — never bundled (§21).
4. English voice output.
5. Telegram voice-note transport; WAV → Opus only at the transport boundary.
6. Keep the original response untouched in UI, history and text.

### Phase 3a — spoken notifications (§12A)

The dozen fixed templates. Ships on top of Phase 3 with no renderer.

1. Template set, tuned by ear against JOY and the English voice.
2. Number-to-words and the path-shortening rule for interpolated values.
3. Wire to `RemoteNotificationFanout`.
4. **Stop here and find out whether full response reading is wanted.**

### Phase 4 — code-aware pronunciation (only if Phase 3a proves demand)

1. Implement the Markdown-aware `SpeechRenderer` (§13).
2. Implement generic identifier/number/path rules.
3. Strip emoji from the speech-only copy.
4. Prototype `[[ raw phoneme ]]` on 15 terms before writing a lexicon (§15).
5. Seed 100-200 terms only after that prototype works.
6. Keep text fallback; add the workspace override JSON.

### Phase 5 — optimize only from measurements

Candidates:

- resident CPU Piper process if startup latency matters;
- a Whisper Node addon only if process startup proves material **and** reliable
  disposal can be demonstrated;
- secondary-GPU STT scheduling (GPU backend only);
- VAD for long voice notes (segment selection — note that basic trailing-silence
  trimming is **not** here, it ships in Phase 1, §24);
- language-segmented TTS;
- streaming partial transcript UI;
- the native SDL2 capture helper (§8.3 Option A′), if §8 ever opens.

---

## 24. Test matrix — split by phase and by CI tier

**Restructured 2026-09-03 (second pass).** The earlier flat "minimum" matrix
listed deferred sidebar capture, both GPU configurations, full-response rendering
and raw phonemes as if they gated the first release — contradicting the
phase-split acceptance criteria in §25.

### CI tiers — what `npm run ci` may contain

| Tier | Runs in `npm run ci` | Needs |
| --- | --- | --- |
| **A. Unit / fake runner** | **yes, always** | nothing |
| **B. Local integration** | no — separate script | real binary + model, this machine |
| **C. Manual / subjective** | no | ears |

**Tier A requires a fake STT runner, and that is a design constraint on
`WhisperRunner`, not a test convenience.** A checked-in WAV fixture cannot drive
a real end-to-end test in CI: faster-whisper would need Python plus a
multi-gigabyte model, whisper.cpp a platform binary plus the same model. Neither
belongs in `npm run ci`. So `WhisperRunner` must be an interface with a fake
implementation that replays a canned transcript — including the failure shapes
(non-zero exit, empty output, invalid/truncated JSON, a backend-specific marker
or refusal when enabled, and cancellation mid-run). Everything above the runner — normalization dispatch,
the admission rule (§7), the draft machine (§9.6), §8A grammar, audit events
(§20.1), cleanup — is then fully testable with no model, no GPU and no network.

The WAV fixtures still earn their place: they drive **Tier B**, where backend
swaps and bias-prompt changes are compared against known audio without
re-listening by hand.


### The safety corpus (R3) — Tier B, and the one that can disqualify a backend

Average accuracy does not measure the expensive mistakes. Build a paired corpus
in **both languages** before the Phase 0 bake-off, covering at minimum:

```text
approve                    do not approve            μην εγκρίνεις
cancel                     do not cancel             μην ακυρώσεις
stop                       stop after this finishes
yes                        I said no, not yes
keep                       undo
read                       write
```

Record each pair under quiet speech, background noise, and as a delayed or
replayed voice note.

**Score the transcript and the resulting grammar action separately.** An
imperfect transcript is tolerable; a false authorization action is not. Per §22A
R2, **zero false approve/deny/stop actions is a gate, not a threshold** — a
backend that produces one is disqualified whatever its accuracy.

Greek negation deserves specific attention: `μην` and `όχι` are short, often
unstressed, and are exactly the tokens both a trimmer (R7) and a decoder under
noise drop first. The R3 corpus and the R7 trimming sweep must be run against
each other, not independently.

### Semantic assertions beside each fixture (R9) — Tier B

Store expected semantic fields next to every fixture so backend swaps compare
deterministically instead of by ear. Assert:

- negation survives;
- filenames and identifiers stay distinguishable;
- numbers and model versions stay correct;
- `read` is never transcribed as `write`;
- `keep` is never transcribed as `undo`;
- English technical tokens survive inside Greek sentences (§6.4's case).

### Phase 1 — STT correctness  (A: dispatch + failure shapes · B: accuracy)

- English normal speech;
- Greek normal speech;
- Greek sentence containing English coding terms;
- English sentence containing symbols/model versions;
- silence-only input;
- very short utterance;
- long utterance;
- cancellation while Whisper is running;
- invalid/corrupt audio;
- **trailing hallucination (measured risk, §27.1) — mitigation is MANDATORY in
  Phase 1, not a Phase 5 optimization.** The earlier revision listed VAD under
  Phase 5 while requiring trailing-silence mitigation in the Phase 1 tests; the
  contradiction is resolved in favour of Phase 1, because this is the failure
  that puts words the user never said in front of an agent that acts on them.
  **Phase 1 ships silence trimming, not VAD**: trim leading/trailing silence in
  the `AudioNormalizer` ffmpeg step (`silenceremove`). Choose the threshold and
  minimum-silence parameters from the Phase 0 fixtures, and include quiet speech
  plus soft initial/final consonants so the mitigation cannot solve trailing
  hallucination by clipping real words. Full VAD (segment selection inside long
  audio) stays in Phase 5. whisper.cpp appends spurious end-of-audio lines — a
  line repeated ×4, a stray "Thank you." Test a recording with trailing silence
  and assert the expected spoken sentence is preserved without appended text;
- backend-specific markers and failure shapes are not admitted as prompts. Port
  `looksLikeTranscriptionRefusal()` or `stripPromptEcho()` from Gemma4kids only
  for a backend shown to emit those shapes, with false-positive fixtures (§7);
- CPU path (Tier B — the leading candidate, §6.1);
- GPU path (Tier B, GPU backend only — never in `npm run ci`);
- second-GPU path when available (Tier B, GPU backend only).

### Phase 1 — resource lifecycle  (Tier A, except the VRAM rows)

- Whisper process always exits;
- temp audio always deleted;
- VRAM returns after STT process exit;
- Qwen remains resident when a CPU STT backend is selected;
- no duplicate submission on Telegram retry;
- no double transcription from repeated stop events;
- **concurrency:** two simultaneous Telegram transcriptions serialize through
  the §19 queue/mutex and neither request is dropped. Add the cross-surface case
  only if deferred sidebar capture ships;
- **size ceiling:** an over-size voice note is rejected before `getFile` when
  Telegram supplies metadata, and a missing/false `file_size` is still stopped
  while streaming when actual bytes cross `voice.input.max_bytes` (§9.2).

### Phase 2 — sidebar capture  (DEFERRED with §8; do not write these yet)

- microphone helper starts/stops;
- cancel removes file;
- default input device works;
- device missing/error produces actionable message;
- no dependency on webview microphone permission.

### Phase 3 / 3a / 4 — Piper  (A: dialect + failure · B: audio · C: quality)

- JOY normal Greek;
- English voice normal English;
- mixed technical sentence;
- raw phoneme span accepted;
- fallback replacement works;
- code block omitted/summarized;
- emoji removed from speech copy without changing original text;
- original assistant text unchanged;
- Piper failure does not lose textual response;
- cancellation while Piper is synthesizing leaves no orphan process, no
  partial audio played, and the text response intact.

### Phase 1 / 1.5 — Telegram, draft machine and grammar  (Tier A)

- voice while session locked is rejected exactly like text;
- authorized voice submits once;
- voice download remains binary-safe;
- over-size/over-duration voice rejected before expensive processing;
- ordinary Unicode Greek/English text, emoji included, remains accepted unchanged;
- response voice conversion failure still leaves text response available;
- **draft machine (§9.6):** `/ok` admits the transcript; `/no` clears it with no
  prompt created; a text reply to the draft echo replaces it as the corrected
  prompt; existing commands retain their meaning; unrelated ordinary text
  supersedes the draft and is admitted normally; a second voice note replaces
  the draft and says so; an expired draft admits nothing;
- **a session lock or TOTP challenge clears a pending draft** — an unconfirmed
  transcript must not survive re-auth;
- **precedence (§9.6):** with both an approval gate and a draft open, `approve`
  resolves the approval and does not touch the draft;
- **§8A grammar:** "do not approve that" approves nothing; `approve` with no gate
  open is not silently dropped; a non-matching utterance falls through to
  ordinary admission;
- **audit events (§20.1):** every operation emits exactly one terminal row;
  a rejected note emits `voice_ingress_rejected` and creates no user turn;
- **cleanup:** temp files are gone as soon as STT succeeds, rejects, or is
  cancelled; holding or expiring a draft never extends audio retention.

---

## 25. Acceptance criteria

Split by phase, because "the first useful release" is now Phase 1 + 1.5 — not the
whole document. Do not hold Phase 1 hostage to the TTS criteria.

### Phase 1 + 1.5 — the first useful release

1. a Telegram Greek or English voice note becomes an ordinary Forge prompt
   locally, with no cloud speech service involved;
2. the transcript is shown for confirmation before it is acted on, and a
   backend-recognized failure, an empty result or interrupted process output is
   never admitted (§7, §9.5);
3. the STT process is fully gone and temp audio deleted before the coding-model
   turn begins — and on the CPU backend, no VRAM was taken to begin with (§6.1);
4. the transcript follows every existing queue, auth, TOTP, dedup and approval
   semantic that typed remote input follows;
5. audio never becomes a UTF-8/base64 attachment string; it is streamed into a
   bounded temp file and both metadata and actual-byte limits are enforced
   (§9.2);
6. spoken approvals work over a closed grammar with the auth path intact, and
   "do not approve that" does not approve anything (§8A);
7. every voice turn is reconstructable from the session log — surface, backend,
   model, language, durations, and whether the user edited it before sending
   (§20.1);
8. the whole path runs in tests from a checked-in WAV fixture, with no
   microphone, network or GPU (§5).

**R10: TTS does not gate this release.** Criteria 1-8 are the product milestone.
Piper validation may run in parallel, but nothing below blocks shipping Phase 1 +
1.5, and no TTS criterion may be promoted into this list later.

### Phase 3 + 3a — spoken output

9. JOY speaks a Greek Forge status notification locally, from a
   **user-supplied** voice file that Forge never bundles or redistributes, with
   the CC BY-NC attribution surfaced (§21);
10. an English Piper voice does the same in English;
11. the visible response text is byte-identical whether or not speech is on;
12. assistant emoji never reaches Piper, while the visible text keeps it;
13. a Piper failure never costs the user the textual response.

### Phase 4 — only if Phase 3a proved demand

14. at least a starter set of technical terms is pronounced intentionally rather
    than letter-by-letter;
15. raw-phoneme injection is proven against JOY, or falls back cleanly to
    deterministic text replacement.

---

## 26. Recommended starting work tomorrow

Start with the smallest vertical slice that proves the architecture:

```text
Telegram voice
 -> binary download (explicit encoding, size-checked BEFORE getFile — §9.2)
 -> ffmpeg WAV normalization (reuse src/tools/ffmpegLocate.ts)
 -> short-lived STT process (backend chosen by the Phase 0 bake-off — §6.1)
 -> process exit
 -> transcript (refusal/echo filtered — §27.2)
 -> existing RemotePromptAdmission
```

Then test with one English and one Greek voice note, and check both in as
fixtures (§5).

Order after that: **§8A spoken approvals (Phase 1.5) → Piper (Phase 3) → §12A
spoken notifications (Phase 3a) → stop and reassess.** The sidebar microphone is
deferred behind the §8 gate and the full `SpeechRenderer` behind §12A's outcome.

Do **not** start with sidebar recording or the pronunciation lexicon. Once Telegram STT works, the difficult shared transcription path is proven. Add the sidebar mic as a second input producer, then add Piper as an output consumer.

For TTS, prototype JOY pronunciation control outside Forge with 15 technical words before writing a large lexicon. If `[[ raw phoneme ]]` works well, build the lexicon around it. If not, fall back to transliterated speech text without changing the visible response.

This ordering gives the highest chance of having a working local voice-controlled Forge quickly while preserving Forge's existing security, queueing and model-lifecycle architecture.

---

## 27. Prior art already in the sibling workspaces (2026-09-03 sweep)

Before starting Phase 0, note that most of this pipeline has already been built,
shipped, or measured in other repos on this machine. Reuse the evidence; do not
re-derive it. Nothing below is a Forge dependency — it is a TS port / lessons
source, consistent with the "no coupling to sibling projects" rule.

### 27.1 Whisper STT is already installed and measured (Ssuno)

- **Reference doc:** `N:\vs code apps\Ssuno\docs\AUDIO_AND_DOWNLOADS.md`
  (measured on this exact machine).
- **whisper.cpp CUDA build already present:**
  `N:\AI\Tools\whisper.cpp\build\bin\Release\whisper-cli.exe` (+ `whisper-bench.exe`,
  `ggml-cuda.dll`). Model `N:\AI\Tools\whisper.cpp\models\ggml-large-v3.bin`
  (3,095,033,483 bytes — verify size before use). No `large-v3-turbo` present:
  it was **deleted on purpose** — it dropped a final-refrain couplet and
  hallucinated the outro ~40× on a real track. Re-benchmark turbo for short
  command utterances before trusting it; the plan's §6.2 assumption that turbo is
  "likely the practical choice" is contradicted by local measurement on long
  audio.
- **Invocation that works:**
  `whisper-cli.exe -m <model> -f <wav> -l en -otxt -of <out> --no-prints -pp`
  (`-oj` for word-level JSON). Input must be **16 kHz mono WAV** — matches plan §10.
- **Known whisper.cpp failure mode (measured):** hallucinated trailing lines at
  the end of audio (a line repeated ×4, a spurious "Thank you."). For Forge's
  push-to-talk commands this argues for VAD trailing-silence trim and/or a
  max-duration cap, and for not trusting the last sentence of a long note.
- **faster-whisper is the accuracy reference, and it is CPU-only here:**
  `Systran/faster-whisper-large-v3` with `--no-vad` captured a full song
  intro→outro near-perfectly; `small.en` / `tiny.en` dropped quiet passages —
  **never use `.en` models** (plan §6.2 already says this; now it is measured).
  faster-whisper's CUDA path is **broken on this box** (ctranslate2 wants
  `cublas64_12.dll`, not on PATH) so it silently runs CPU int8 — ~1 s for a
  4.5-minute track, never touches VRAM, runs fine alongside Forge/ComfyUI.
  Reference script: `N:\vs code apps\Ssuno\The Space You Left\transcribe_lyrics.py`
  (forces `HF_HUB_OFFLINE=1`, maps the 🎵 token to `[music]`, reconfigures stdout
  to UTF-8 because the console is cp1253 — **keep both behaviours** in any port).
  Cached models: `N:\.cache\huggingface\hub\models--Systran--faster-whisper-*`.
- **This is a real fork in the road for Phase 0:** CPU faster-whisper large-v3
  gives the strongest VRAM-release guarantee of all (it never allocates VRAM), at
  ~1 s/short-utterance latency. It may beat the "short-lived whisper.cpp GPU
  process" design on every axis that matters for a 3-second command. Benchmark
  both in §Phase 0; do not assume GPU.
- **whisper.cpp models live in the `ggerganov/whisper.cpp` HF repo**, not
  `ggml-org/...`. HF fast-download env (`HF_HUB_ENABLE_HF_TRANSFER=1`,
  `HF_XET_*`) is already installed — see the doc.
- **ComfyUI has no STT** — it only ships audio *diffusion* encoders
  (`N:\AI\ComfyUI\comfy\audio_encoders`, `ldm/audio`, `mmaudio`, stable-audio-3).
  The only transferable "conclusion to ComfyUI" is the **one-GPU-model-at-a-time**
  rule: GPU whisper.cpp obeys the same single-slot VRAM discipline as ComfyUI, so
  the coding model and GPU STT genuinely contend. CPU STT sidesteps it entirely.

### 27.2 A dual-llama-server STT design is already implemented (Gemma4kids)

Gemma4kids shipped almost exactly the "second managed server for STT only"
architecture on **2026-05-08**. It targets a Gemma-3n E4B **audio-multimodal**
model rather than whisper, but the process/VRAM/lifecycle scaffolding is directly
portable.

- **Plan doc:** `N:\vs code apps\Gemma4kids\plan-dual-stt-server.md` (marked
  ✅ IMPLEMENTED).
- **Implementation:** `N:\vs code apps\Gemma4kids\src\main\llamaSttRuntime.ts`
  (316 LOC) + `llamaSttUtils.ts` + shared `src\shared\transcription.ts`.
- **Directly reusable decisions:**
  - separate `LlamaCppSttConfig` type (no ctx/predict/cache fields) rather than
    extending the chat config — "keeps chat config lean";
  - **lazy start on first transcribe call** — zero VRAM until the mic is pressed;
  - dedicated STT port (they use 8081 vs chat 8080), with a port-resolution step
    that *excludes the active chat port* and can *reuse an already-running*
    compatible server;
  - in-flight startup dedup guard keyed by a JSON config key;
  - spawn args:
    `-m <model> [--mmproj <auto-detected>] --host 127.0.0.1 --port <p> --jinja
    --ctx-size 8192 --batch-size 512 --parallel 1 --flash-attn on
    --n-gpu-layers <n>`;
  - 120 s startup timeout; poll `/v1/models` for readiness; on early exit surface
    `stderr`/`stdout` tails to the user (matches Forge's "no buried errors" rule);
  - **`void stopManagedSttServer()` immediately after every transcription** to
    release STT VRAM while the coding server stays loaded — this *is* the plan's
    §7 hard release barrier, already written, including `killProcessTree`.
- **Transcribe call shape** (if a future phase ever uses an audio LLM instead of
  whisper): `POST /v1/chat/completions` with
  `content: [{type:'input_audio', input_audio:{data:<b64>, format:'wav'}}, {type:'text', text:<prompt>}]`,
  `stream:false`, `max_tokens:512`; **fallback to `llama-mtmd-cli`** when the
  server returns an "audio unsupported" error (`shouldFallbackToMtmdCli`).
- **`src/shared/transcription.ts` is a gift** — dependency-free (no Electron/DOM/
  Node), already bundles:
  - `buildTranscribePrompt(languageHint)` with hardened per-language prompts
    (`el`, `el+strict`, `de`, `en`, auto). The Greek prompt explicitly forbids
    translation/transliteration and **Arabic/Cyrillic script output** — a real
    observed drift mode of multilingual models. "Output only the transcription
    text, with no newlines. Write numbers as digits." Port these verbatim.
  - `stripPromptEcho()` — fine-tuned/instruct models echo the prompt back;
  - `looksLikeTranscriptionRefusal()` — detects "no audible speech" / "cannot
    transcribe" style refusals so they are not admitted as a user prompt. Forge's
    §7 "do not submit empty/partial text" needs exactly this.
- **Caveat:** this path proves script-drift and prompt-echo are real even for a
  purpose-tuned model. whisper.cpp avoids both (it is not instruction-following),
  which is a point in favour of keeping whisper as the Phase 1 backend.

### 27.3 Piper TTS is already integrated, cross-platform, with a findings log (Gemma4kids)

- **Plan:** `N:\vs code apps\Gemma4kids\tts_plan.md` (2026-04-27).
- **Implementation:** `N:\vs code apps\Gemma4kids\src\main\ttsMain.ts` (313 LOC) —
  a working reference for the `PiperRunner` + `VoiceOutputRouter` modules in §5.
  Reusable pieces:
  - `scanVoices()` — reads every `*.onnx` + sidecar `.onnx.json`, pulls
    `audio.sample_rate` and `espeak.voice` (language) from the config, tolerates
    one malformed voice config without killing the list;
  - `selectVoice(voices, langHint)` — dominant-language pick with English then
    first-voice fallback (plan §16);
  - `buildWavHeader(pcmLength, sampleRate)` — the 44-byte header for the
    **rhasspy** `--output-raw` (stdout PCM) path;
  - **two Piper CLI dialects handled:** rhasspy `--output-raw` (stdin→stdout PCM,
    caller builds the WAV header) vs the arm64 build's
    `--model … --output_file <path>` (writes a complete WAV). §11.2's "expect an
    external local Piper command" abstraction must cover both.
  - text is written to Piper **stdin**, `proc.stdin.end()`, collect `stdout`; on
    non-zero exit reject with the `stderr` tail.
- **macOS findings (hard-won):**
  `N:\vs code apps\Gemma4kids\docs\piper-mac-arm64-findings.md` +
  `mac-piper-packaging-plan.md`:
  - rhasspy's `piper_macos_aarch64.tar.gz` (2023.11.14-2) contains an **x86_64**
    binary (`bad CPU type` on M-series) and the macOS archives **omit
    `libespeak-ng`, `libpiper_phonemize`, `libonnxruntime.1.14.1`** — Homebrew
    can't supply 1.14.1. Known upstream: rhasspy/piper #404, #523.
  - Working macOS arm64 binary: **`itsabhishekolkha/piper-arm-build` v1.2.0**
    (`piper-arm64-some.deps.deps`, 45 MB) — self-contained (`otool -L` shows
    system libs only), but it is a **PyInstaller bundle** with a ~1–2 s
    first-invocation unpack to `/tmp/_MEI…`. Fine for a demo, needs a real C++
    static build for production.
  - `OHF-voice/piper1-gpl` wheel is a **Python extension module** (`espeakbridge.so`
    only) — cannot be spawned from Node. Confirms plan §2.6/§11.2: treat Piper as
    an external process, not a lib.
  - macOS `say` (`-v Melina` for `el`) is the last-ditch fallback — works, poor
    quality. Windows/Linux rhasspy archives are fine (include all dylibs).
- **Piper training env gotchas** (only relevant if a voice is ever retrained —
  plan §22 says don't): `N:\vs code apps\Gemma4GR\PIPER_DOCKER_FIXES.md` —
  RTX 5060 Ti (Blackwell sm_120) needs `nvcr.io/nvidia/pytorch:25.01-py3`+;
  `piper-train` is off PyPI (install from `rhasspy/piper` source); Docker can't
  mount `N:` network drives; cp1253 console needs forced UTF-8.

### 27.4 The JOY Greek voice — files, license, provenance (Gemma4GR / Gemma4kids)

- **Voice card:** `N:\vs code apps\Gemma4GR\VOICE_CARD.md` /
  `N:\vs code apps\Gemma4kids\voices\el_GR-joy-medium.VOICE_CARD.md`.
- `el_GR-joy-medium` — Piper VITS, **22050 Hz**, speaker Chara Kaltsou, trained
  on **3,216 human utterances** (LJSpeech format), 20 epochs, medium tier. No
  synthetic audio in training.
- **License: CC BY-NC 4.0** — *NonCommercial*. This is a **distinct and stricter
  constraint than the Piper-runtime GPL issue in plan §2.7 / §21**, and the plan
  currently does not mention it. If Forge ever ships to the VS Code Marketplace
  with JOY bundled, the voice's NC clause is the blocker, not just the runtime
  license. Attribution string required: *"JOY Greek voice (el_GR-joy-medium),
  Gemma4GR project — https://github.com/Efs-O/Gemma4GR, CC BY-NC 4.0"*.
  Commercial licensing contact is the project author.
- **Local copies of the model** (`el_GR-joy-medium.onnx` + `.onnx.json`):
  `N:\vs code apps\Gemma4kids\voices\`, `...\JOY\`, `...\joy-greek-tts-upload\`,
  `N:\vs code apps\Gemma4GR\output\piper_voice\`.
- Baseline Greek voice for A/B was `el_GR-rapunzelina-medium` — checkpoints under
  `N:\.cache\huggingface\hub\datasets--rhasspy--piper-checkpoints\...\el\el_GR\rapunzelina\medium`.
  Conclusion from Gemma4GR's `VOICE_CARD` rationale: every pre-existing community
  Greek voice was trained on synthetic/low-quality data and is "robotic,
  mispronounced" — JOY exists because nothing else was usable. So for Greek TTS
  in Forge there is effectively one option.

### 27.5 Greek STT A/B evidence and the task-interference finding (Gemma4GR)

Not directly reusable (it is about fine-tuning Gemma E4B, not whisper), but one
conclusion matters for Forge's design:

- `N:\vs code apps\Gemma4GR\FINAL_STT_RUN_PLAN.md` +
  `output\ab_final_stt_vs_base_*.json` (2026-05-14): mixing an STT objective with
  a spoken-QA objective in one model **degraded transcription** — fine-tuned
  failures were "meta-responses or prompt echoes". Reinforces the plan's central
  rule: **do not give one model both the "transcribe" job and the "answer" job.**
  Voice stays a transport; whisper transcribes; the coding model only ever sees
  text. A/B harness for reference: `N:\vs code apps\Gemma4GR\tests\stt_benchmark.py`,
  `training\compare_piper_voices.py`.
- Greek STT prompt that was trained against:
  `N:\vs code apps\Gemma4GR\greek_stt_prompt.txt` (pair it with the hardened
  prompts in §27.2 if an audio-LLM path is ever revisited).

### 27.6 Net recommendation delta — all folded into the body (2026-09-03)

Every item below has been applied to the sections it contradicted. This list is
kept as provenance: it records *why* those sections say what they say. Landing
sites are named per item.



1. → **§6.1, §6.2, §23 Phase 0.** **Phase 0 must benchmark CPU faster-whisper-large-v3 as a first-class STT
   backend**, not just as a fallback. On this machine it is already installed,
   already measured accurate, and gives a perfect VRAM-release story. The plan's
   "short-lived whisper.cpp GPU process" may be solving a problem (VRAM release)
   that the CPU path doesn't have.
2. → **§6.2, §23 Phase 0.** **Drop the `large-v3-turbo` default assumption** (§6.2) pending a short-utterance
   re-benchmark — it was deleted here for hallucinating.
3. → **§7, §24 STT correctness.** Reuse only the applicable pieces of
   `src/shared/transcription.ts` from Gemma4kids. Its refusal/echo filters target
   an instruction-following audio LLM and are backend-specific, not unconditional
   whisper postprocessing.
4. → **§5, §6.1.** Folded into `WhisperRunner.ts` (the separate
   `WhisperLifecycle.ts` was dropped). Reuse `llamaSttRuntime.ts` lessons that
   apply to a one-shot child process — cancellation, exit waiting and surfaced
   stderr/stdout tails. Its server port/startup-polling machinery does not apply
   to the Phase 1 whisper CLI runners.
5. → **§5.** Folded into `PiperRunner.ts`. **Port `ttsMain.ts`** (`scanVoices`, `selectVoice`, `buildWavHeader`,
   dual-CLI-dialect spawn) as the skeleton for `PiperRunner.ts` / `PiperLifecycle.ts`.
6. → **§21, §25 item 9. DONE — it is now the first subsection of §21, ahead of the runtime GPL question, because it is the stricter blocker.** **Add a §21 sub-point for the JOY CC BY-NC 4.0 voice license** — it is a
   separate redistribution blocker from the Piper GPL runtime and is currently
   unaddressed.
7. → **§24 STT correctness. DONE.** **whisper.cpp trailing-hallucination is a measured risk** — add VAD /
   max-duration trim and end-of-audio distrust to the §24 STT test matrix.
8. Reference-doc pointers to keep in Forge diagnostics:
   `Ssuno/docs/AUDIO_AND_DOWNLOADS.md`, `Gemma4kids/plan-dual-stt-server.md`,
   `Gemma4kids/tts_plan.md`, `Gemma4kids/docs/piper-mac-arm64-findings.md`,
   `Gemma4GR/VOICE_CARD.md`, `Gemma4GR/FINAL_STT_RUN_PLAN.md`,
   `Gemma4GR/PIPER_DOCKER_FIXES.md`.
