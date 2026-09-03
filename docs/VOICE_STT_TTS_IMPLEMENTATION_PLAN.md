# Forge Voice Input / STT / TTS Implementation Plan

Status: implementation handoff, research-reviewed revision
Target: Forge `main`
Date: 2026-09-03

## 1. Goal

Add a complete local-first voice path to Forge without creating a second agent loop and without requiring the coding model to consume audio directly.

The feature should support:

- microphone input initiated from the Forge sidebar;
- Telegram voice messages;
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
- text-only, voice-only where appropriate, or text+voice output policies per surface;
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

### 2.9 Phase 1 emoji policy

Do not spend early implementation time on Unicode emoji normalization, speech names, skin-tone modifiers, ZWJ sequences, or Telegram-specific emoji edge cases.

**Phase 1 policy:**

- Telegram inbound **text prompts containing emoji are rejected before prompt admission** with a concise message such as `Forge: emojis are not supported in remote prompts yet.`;
- voice transcripts contain no generated emoji and therefore require no special STT handling;
- assistant text remains untouched and may still contain emoji;
- the TTS `SpeechRenderer` strips emoji from the speech-only copy before Piper;
- sidebar typed-chat behavior outside the new voice path is not changed merely for this feature;
- revisit full Unicode/emoji support only after the STT/TTS path is stable.

Implementation should use Unicode-aware emoji detection rather than an ASCII range hack. Keep this as a transport/input policy, not a tokenizer/model modification.

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
  VoiceTypes.ts
  VoiceIngress.ts
  AudioNormalizer.ts
  MicrophoneCapture.ts
  WhisperRunner.ts
  WhisperLifecycle.ts
  SpeechRenderer.ts
  PronunciationLexicon.ts
  PiperRunner.ts
  PiperLifecycle.ts
  VoiceOutputRouter.ts
```

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

## 6. STT backend: `whisper.cpp`

### 6.1 Phase 1 decision

Use a short-lived `whisper.cpp` CLI process for each completed recording/Telegram voice message.

Why this is preferred even though tighter APIs exist:

- simplest lifecycle to reason about;
- process exit is a strong CUDA-context teardown boundary;
- no native Node addon ABI problem;
- no long-lived STT server;
- cancellation can terminate the process;
- stdout/file output is easy to parse;
- easy CPU/GPU A/B testing;
- compatible with future migration to an addon/library after behavior is measured.

### 6.2 Model candidates

Benchmark these in Greek and English:

1. `large-v3` — quality reference;
2. `large-v3-turbo` — likely practical quality/speed choice;
3. quantized `large-v3-turbo` variants — only if Greek quality remains acceptable.

Never use `.en` checkpoints when Greek input is enabled.

Default language policy:

```text
auto
```

Expose explicit `el` and `en` for testing and troubleshooting.

### 6.3 Use current stable whisper.cpp, not an old copied binary

At implementation time pin a tested whisper.cpp release. The project is actively changing; VAD, device selection, ffmpeg decoding and bindings have continued evolving in 2026.

Record the tested version in Forge docs/config diagnostics.

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
  -> only then submit transcript
```

For Phase 1 the strongest release barrier is **child process exit**.

Pseudo-code:

```ts
const result = await whisperRunner.transcribe(tempWav, options);
await result.processExited;
await cleanupTempAudio(tempWav);
await submitExistingForgePrompt(result.text);
```

Do not call prompt admission merely because a line of transcript has appeared on stdout. Wait for successful terminal process completion.

### VRAM policy

Priority:

1. GPU Whisper if it fits without disturbing the coding model;
2. CPU Whisper if GPU allocation would require evicting the coding model;
3. configurable secondary GPU when available;
4. unloading/reloading Qwen only as explicit last-resort behavior.

Why: unloading Qwen costs model reload time and can destroy warm prefix/KV advantages for a very short voice command.

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

## 8. Sidebar microphone: corrected implementation

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

#### Option B — ffmpeg local microphone capture

Forge already treats ffmpeg as an optional local dependency for video features, so reuse may be attractive. On Windows, device selection is less elegant and must be tested carefully. Do not hard-code a microphone device name.

Use only if device discovery/default-device UX is acceptable.

#### Option C — `whisper-stream` / `whisper-command`

These already prove local microphone capture works. They are useful as prototypes or fallback helpers.

However, they load Whisper while listening. For push-to-talk Forge UX, capture-first/transcribe-second is more VRAM-efficient.

### 8.4 Future optimization

If upstream VS Code eventually permits microphone access in webviews reliably, `MediaRecorder` can become an alternate capture backend. It should not block Phase 1.

---

## 9. Telegram voice input

### 9.1 Extend Telegram schema

Add `message.voice`, including at minimum:

- `file_id`;
- `duration`;
- `mime_type` when provided;
- `file_size` when provided.

Telegram voice notes should enter Forge as a dedicated audio/voice attachment classification, not as text.

### 9.2 Fix binary attachment handling

Current Forge code converts non-image/non-PDF attachments to UTF-8 strings. That path is invalid for audio.

Introduce one of:

```ts
dataBytes?: Buffer
```

or a temporary-file-oriented binary attachment contract.

Do not base64 audio unless an existing store boundary specifically requires it. Prefer bytes/temp-file references internally to avoid needless copies.

### 9.3 Telegram path

```text
Telegram voice
 -> existing owner/private/TOTP/session checks
 -> validate size/duration
 -> getFile
 -> download binary bytes
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

### 9.4 Telegram text emoji guard (Phase 1)

Before ordinary Telegram text reaches prompt admission, detect Unicode emoji. If any are present, reject the remote prompt and return a clear message. This guard is intentionally temporary and should be isolated so it can be removed later without touching prompt/tokenization logic.

Do not reinterpret, transliterate or silently drop emoji from a user-authored Telegram prompt in Phase 1; reject it instead so the user knows the exact text was not submitted.

### 9.5 UX

Use existing remote progress infrastructure for a small status such as:

```text
Transcribing voice…
```

On success, submit immediately by default.

On failure, do not submit empty/partial text.

Optional later mode: echo transcript for approval before submission.

---

## 10. Audio normalization

Do not use MP3 as an intermediate format.

Expected inputs:

- Telegram: OGG/Opus;
- local capture helper: ideally already 16-bit mono WAV/PCM.

Target Whisper input for the simple Phase 1 path:

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

### 11.1 Phase 1 decision

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

### 11.2 Do not make the Phase 1 implementation depend on Python

The maintained Piper project supports Python APIs and HTTP server operation, but also provides `libpiper`/C++ tooling in current versions.

For Forge Phase 1, the abstraction should simply expect an external local Piper command/runtime. The exact installed distribution can be swapped without affecting the speech renderer.

### 11.3 Do not keep spawning Piper once per sentence if latency is poor

Piper documentation notes that CLI startup repeatedly reloads the model and can be slower than a resident server.

Unlike Whisper, Piper is small and CPU-side, so a resident Piper process is acceptable if measurements show startup overhead matters.

Therefore:

- Phase 1 may begin with one-shot CLI simplicity;
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

## 13. SpeechRenderer

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
    telegram: text | voice | text_and_voice
```

Recommended default:

```text
sidebar: off
telegram: text
```

Users explicitly opt into spoken responses.

For Telegram, if sending a native voice note requires Opus/Ogg, convert the locally synthesized WAV to the Bot API's preferred voice-note format only at the transport boundary. Do not change Piper's internal output format just for Telegram.

---

## 18. Proposed config

Illustrative only; follow current Forge schema conventions.

```yaml
voice:
  enabled: true

  input:
    sidebar: true
    telegram: true
    max_seconds: 180
    max_bytes: 25000000
    reject_telegram_emoji: true

  capture:
    backend: helper       # helper | ffmpeg | future-webview
    helper: C:/path/to/forge-audio-capture.exe

  stt:
    backend: whisper.cpp
    binary: C:/path/to/whisper-cli.exe
    model: C:/path/to/ggml-large-v3-turbo.bin
    language: auto
    prefer_gpu: true
    fallback_cpu: true
    gpu_device: auto
    flash_attn: true

  tts:
    enabled: false
    backend: piper
    binary: C:/path/to/piper.exe
    greek_voice: C:/path/to/el_GR-joy-medium.onnx
    english_voice: C:/path/to/en_US-voice.onnx
    language: auto
    speak_code_blocks: false
    strip_emoji: true
    pronunciation_file: .forge/tts-pronunciations.json

  output:
    sidebar: off
    telegram: text
```

Do not require every field. Establish sensible local defaults where Forge can discover them safely.

---

## 19. Cancellation and concurrency

Voice has several asynchronous stages. Treat them as one cancellable operation until the text prompt is admitted.

```text
recording
 -> decoding
 -> STT
 -> release
 -> prompt admission
```

If cancelled before prompt admission:

- terminate capture helper;
- terminate Whisper process;
- wait for process exit;
- remove temp files;
- do not create a user message.

Do not permit two STT GPU jobs simultaneously by default.

Use a small `VoiceTranscriptionQueue` or mutex if both Telegram and sidebar can trigger transcription concurrently.

After transcript admission, normal Forge queue/steer behavior takes over.

---

## 20. Security and privacy

Voice input is executable intent after transcription, so preserve every existing Forge control boundary.

Requirements:

- Telegram voice must pass existing remote authentication/session gates;
- voice must not bypass Clanker/approval semantics;
- transcript is treated exactly like typed user input after admission;
- Telegram emoji rejection happens before prompt admission in Phase 1;
- audio size and duration are bounded;
- decoder paths receive fixed argv, never shell-interpolated filenames;
- temp files are not written to workspace by default;
- no automatic retention of recordings;
- no hidden cloud transcription/TTS calls;
- config must make local executable/model paths explicit;
- remote voice duplicates must inherit existing Telegram deduplication semantics.

---

## 21. Licensing/package boundary

### Whisper

Use the upstream `whisper.cpp` license and attribution requirements appropriate to the pinned distribution.

### Piper

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
- retraining JOY merely for code vocabulary;
- embedding `libpiper` into Forge before licensing is settled.

---

## 23. Fastest implementation path

### Phase 0 — standalone validation before touching agent logic

1. Pin current whisper.cpp build.
2. Test `large-v3`, `large-v3-turbo`, one quantized turbo candidate.
3. Record 15-20 short Greek coding commands and 15-20 English coding commands.
4. Measure WER/subjective command accuracy and latency.
5. Measure VRAM before load, peak and after child-process exit.
6. Confirm CPU fallback speed.
7. Pin/test Piper runtime with JOY.
8. Test Piper `[[ raw phoneme ]]` syntax with JOY.
9. Build a 15-term technical pronunciation sample set.
10. Confirm one-shot Piper startup latency.

### Phase 1 — Telegram STT first

Telegram is the easiest end-to-end input because Telegram already records the microphone.

1. Extend `TelegramUpdateSchema` with `voice`.
2. Add binary attachment handling.
3. Add the temporary Telegram text emoji-rejection guard.
4. Download OGG/Opus bytes.
5. Normalize to WAV locally.
6. Spawn whisper.cpp.
7. Wait for exit.
8. Submit transcript through existing `RemotePromptAdmission`.
9. Add `Transcribing voice…` progress.
10. Add failure/cancellation tests.

**Do this before sidebar microphone capture.** It validates almost the entire STT/prompt pipeline without solving local audio capture at the same time.

### Phase 2 — sidebar microphone

1. Add mic UI state machine.
2. Implement extension-host capture helper.
3. Prefer capture-only helper producing 16 kHz mono WAV.
4. Reuse the exact same `VoiceIngress -> WhisperRunner` path from Telegram.
5. Add cancellation.
6. Verify no webview microphone permission is required.

### Phase 3 — TTS basic

1. Add `PiperRunner` external-process abstraction.
2. JOY Greek output.
3. English voice output.
4. Sidebar playback.
5. Telegram text+voice transport.
6. Keep original response untouched.
7. Strip emoji from the speech-only copy before Piper.

### Phase 4 — code-aware pronunciation

1. Implement Markdown-aware `SpeechRenderer`.
2. Implement generic identifier/number/path rules.
3. Seed 100-200 common technical terms only after the 15-term prototype works.
4. Add `[[ raw phoneme ]]` injection for tested entries.
5. Keep text fallback.
6. Add workspace override JSON.

### Phase 5 — optimize only from measurements

Candidates:

- resident CPU Piper process if startup latency matters;
- Whisper Node addon only if process startup proves material and reliable VRAM disposal can be demonstrated;
- secondary-GPU STT scheduling;
- VAD for long voice notes;
- language-segmented TTS;
- transcript confirmation mode;
- optional streaming partial transcript UI;
- full emoji normalization/speech support after the basic path is stable.

---

## 24. Minimum test matrix

### STT correctness

- English normal speech;
- Greek normal speech;
- Greek sentence containing English coding terms;
- English sentence containing symbols/model versions;
- silence-only input;
- very short utterance;
- long utterance;
- cancellation while Whisper is running;
- invalid/corrupt audio;
- CPU fallback;
- GPU path;
- second-GPU path when available.

### Resource lifecycle

- Whisper process always exits;
- temp audio always deleted;
- VRAM returns after STT process exit;
- Qwen remains resident when CPU STT fallback is selected;
- no duplicate submission on Telegram retry;
- no double transcription from repeated stop events.

### Sidebar capture

- microphone helper starts/stops;
- cancel removes file;
- default input device works;
- device missing/error produces actionable message;
- no dependency on webview microphone permission.

### Piper

- JOY normal Greek;
- English voice normal English;
- mixed technical sentence;
- raw phoneme span accepted;
- fallback replacement works;
- code block omitted/summarized;
- emoji removed from speech copy without changing original text;
- original assistant text unchanged;
- Piper failure does not lose textual response.

### Telegram

- voice while session locked is rejected exactly like text;
- authorized voice submits once;
- voice download remains binary-safe;
- over-size/over-duration voice rejected before expensive processing;
- Telegram text containing emoji is rejected before prompt admission in Phase 1;
- ordinary Unicode Greek/English text without emoji remains accepted;
- response voice conversion failure still leaves text response available.

---

## 25. Acceptance criteria

The first useful release is complete when:

1. a Telegram Greek or English voice note becomes an ordinary Forge prompt locally;
2. a sidebar microphone button can record without relying on webview microphone permission;
3. Whisper is fully gone before the coding-model turn begins;
4. the same transcript follows existing Forge queue/auth/approval semantics;
5. JOY can speak a Greek Forge response locally;
6. an English Piper voice can speak an English Forge response locally;
7. the visible response remains exact while speech uses a separate renderer;
8. at least a starter set of technical terms is pronounced intentionally rather than letter-by-letter;
9. raw-phoneme injection is proven with JOY or cleanly falls back to deterministic text replacement;
10. Telegram text emoji is deliberately rejected during Phase 1 and assistant emoji does not reach Piper;
11. no cloud speech service is required.

---

## 26. Recommended starting work tomorrow

Start with the smallest vertical slice that proves the architecture:

```text
Telegram voice
 -> binary download
 -> ffmpeg WAV normalization
 -> short-lived whisper.cpp
 -> process exit
 -> transcript
 -> existing RemotePromptAdmission
```

In parallel with the Telegram schema change, add the temporary inbound emoji guard for ordinary Telegram text so unsupported emoji never reaches the early remote/voice implementation path.

Then test with one English and one Greek voice note.

Do **not** start with sidebar recording or TTS. Once Telegram STT works, the difficult shared transcription path is proven. Add the sidebar mic as a second input producer, then add Piper as an output consumer.

For TTS, prototype JOY pronunciation control outside Forge with 15 technical words before writing a large lexicon. If `[[ raw phoneme ]]` works well, build the lexicon around it. If not, fall back to transliterated speech text without changing the visible response.

This ordering gives the highest chance of having a working local voice-controlled Forge quickly while preserving Forge's existing security, queueing and model-lifecycle architecture.