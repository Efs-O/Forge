# Forge Voice Input / STT / TTS Implementation Plan

Status: implementation handoff
Target: Forge main
Date: 2026-09-03

## 1. Goal

Add a complete local-first voice path to Forge without changing the existing agent loop semantics or forcing the coding model to understand audio directly.

The feature should support:

- microphone input from the Forge sidebar;
- Telegram voice messages;
- local speech-to-text through `whisper.cpp`;
- Greek and English transcription;
- immediate STT model/process release after transcription;
- delivery of the transcript through the existing normal Forge prompt path;
- optional local text-to-speech through Piper;
- Greek TTS using the existing JOY Piper voice;
- English Piper voices;
- code-aware pronunciation handling so technical responses are not spoken character-by-character;
- pronunciation injection / raw-phoneme support where the selected Piper runtime supports it;
- deterministic fallback text normalization when raw phoneme injection is unavailable;
- independent per-surface output policy: text only, voice only where appropriate, or text + voice;
- no dependency on an LLM call merely to rewrite ordinary text for TTS.

The central rule is:

> Voice is an I/O transport around the existing Forge agent loop, not a new agent mode.

The coding model should normally continue to receive UTF-8 text exactly as it does today.

---

## 2. Proposed architecture

```text
INPUT

Forge sidebar mic                 Telegram voice note
      |                                  |
MediaRecorder / webview                 Bot API
      |                                  |
WebM/Opus or supported blob            OGG/Opus
      |                                  |
      +-------------+--------------------+
                    |
               VoiceIngress
                    |
            normalize/decode audio
                    |
              whisper.cpp
                    |
                transcript
                    |
          HARD STT RELEASE BARRIER
                    |
        existing Forge prompt admission
                    |
             existing agent loop
                    |
                Qwen/etc.
                    |
            assistant response
             /              \
            /                \
    visible original      SpeechRenderer
        response               |
                               |
                       code-aware normalization
                               |
                    pronunciation dictionary
                               |
                  optional Piper phoneme injection
                               |
                            Piper
                               |
                         generated audio
                         /             \
                        /               \
                 sidebar playback   Telegram reply
```

No STT text should be injected into the conversation until the STT engine has released the GPU resources it used.

No TTS-normalized text should replace the original assistant message in conversation history.

---

## 3. Existing Forge surfaces to reuse

Current Forge already has the pieces that should remain authoritative for the final prompt and remote delivery paths:

- `src/remote/TelegramChannel.ts`
- `src/remote/RemoteAttachmentStore.ts`
- `src/remote/RemotePromptAdmission.ts`
- `src/remote/RemoteQueueDrain.ts`
- `src/remote/RemoteController.ts`
- `src/sidebar/AgentLoop.ts`
- existing conversation / prompt admission logic
- existing background-process and model lifecycle patterns

Do not create a second voice-specific agent loop.

Voice transcription must end by calling the same normal prompt admission/send path used for typed text.

---

## 4. New modules proposed

Names are suggestions; preserve existing Forge naming conventions if the current codebase indicates a better placement.

```text
src/voice/
  VoiceIngress.ts
  VoiceTypes.ts
  AudioNormalizer.ts
  WhisperRunner.ts
  WhisperLifecycle.ts
  SpeechRenderer.ts
  PronunciationLexicon.ts
  PiperRunner.ts
  PiperLifecycle.ts
  VoiceOutputRouter.ts
```

Optional resources:

```text
resources/voice/
  pronunciations.en.json
  pronunciations.el.json
```

Workspace/user override, if desired:

```text
.forge/tts-pronunciations.json
```

Built-in pronunciation resources should remain versioned with Forge. User/workspace overrides should extend or override them rather than require modifying the shipped files.

---

## 5. STT: whisper.cpp, not Python Whisper

### Decision

Use `whisper.cpp` as the preferred Forge STT runtime.

Reasons:

- native executable/library model fits Forge better than a Python/PyTorch dependency;
- easier lifecycle management;
- local-only operation;
- explicit GPU/CPU selection;
- multilingual Whisper checkpoints support Greek and English;
- no need to alter the main coding-model protocol.

Do not use English-only `.en` Whisper checkpoints for this feature.

Initial benchmark candidates:

1. `large-v3` as the quality baseline;
2. `large-v3-turbo` as the likely quality/performance choice;
3. an appropriate quantized `large-v3-turbo` whisper.cpp checkpoint if Greek quality remains acceptable.

The user previously observed that the largest Whisper models produced the best English recognition. Greek must be benchmarked separately before choosing the shipping default.

---

## 6. STT lifecycle and VRAM policy

This is one of the most important requirements.

### Hard invariant

```text
transcribe -> release Whisper completely -> only then submit the Forge prompt
```

The implementation must not assume that returning a transcript automatically means CUDA memory has been released.

Preferred sequence:

```ts
const transcript = await whisper.transcribe(audio);
await whisper.dispose();
await whisper.waitUntilReleased();
await submitExistingForgePrompt(transcript);
```

The exact API will depend on process/library integration, but the barrier is mandatory.

### Preferred execution policy

1. If Whisper can run without disturbing the active coding model, use the GPU.
2. If available VRAM is insufficient, prefer CPU STT over unloading the coding model.
3. Only consider unloading/reloading Qwen as an explicit last-resort policy, not the default.

Why: evicting the coding model may cost model reload latency and destroy useful warm/KV state for the sake of a short voice command.

### Future multi-GPU option

Support a configurable Whisper device/GPU assignment so a secondary GPU can handle STT independently of the main coding model.

Suggested config shape, subject to existing Forge config conventions:

```yaml
voice:
  enabled: true
  stt:
    backend: whisper.cpp
    binary: C:/path/to/whisper-cli.exe
    model: C:/path/to/ggml-large-v3-turbo.bin
    language: auto
    device: auto
    prefer_gpu: true
    fallback_cpu: true
```

Do not implement speculative VRAM scheduling until measured on the actual runtime. First measure:

- free VRAM before Whisper load;
- VRAM after load;
- peak during transcription;
- memory after Whisper teardown;
- transcription time on GPU;
- transcription time on CPU;
- Greek word error behavior;
- English word error behavior.

---

## 7. Telegram voice input

Telegram voice notes are normally delivered as a Telegram `voice` object whose underlying audio is typically OGG/Opus.

Proposed path:

```text
Telegram update
  -> detect message.voice
  -> authorize through existing remote auth/session gates
  -> obtain/download file
  -> store through existing attachment/storage conventions
  -> VoiceIngress
  -> whisper.cpp
  -> transcript
  -> delete/release temporary audio according to retention policy
  -> existing RemotePromptAdmission
```

Do not bypass:

- owner matching;
- private-chat policy;
- TOTP/session lock behavior;
- queue/deduplication guarantees;
- existing remote prompt admission.

A voice message is simply another representation of an owner-authored prompt.

### Telegram UX

While transcribing, send/stream a concise status if the current remote progress architecture supports it cleanly, e.g. `Transcribing voice…`.

After transcription either:

- submit immediately, or
- optionally echo a short transcript before the turn begins if a future confirmation mode is added.

Default recommendation: submit immediately once transcription succeeds, matching typed-message behavior.

On STT failure, do not submit an empty or partial prompt. Return a clear remote error.

---

## 8. Forge sidebar microphone

Add a microphone control beside the existing composer/send controls.

### Webview side

Use the VS Code webview browser media APIs, normally `navigator.mediaDevices.getUserMedia({ audio: true })` and `MediaRecorder`, subject to what the current VS Code/Chromium runtime exposes.

Expected capture format may be WebM/Opus depending on runtime support. Do not hard-code MP3 as an intermediate requirement.

Suggested states:

```text
idle -> recording -> stopping -> transcribing -> submitted
```

UI behavior:

- mic button starts recording;
- visible recording state / timer;
- second press stops recording;
- optional cancel action discards recording;
- while STT runs, disable duplicate submission of that recording;
- typed composer remains separate;
- transcript becomes a normal user message once STT teardown completes.

### Extension-host boundary

Do not run Whisper in the webview.

The webview should send recorded bytes/attachment metadata to the extension host. The extension host owns:

- temporary file handling;
- codec normalization if required;
- whisper.cpp execution;
- lifecycle / VRAM barrier;
- prompt submission.

This keeps the privileged process/lifecycle logic out of the UI layer.

---

## 9. Audio normalization

Do not design around MP3.

Likely inputs:

- Telegram: OGG/Opus;
- sidebar: WebM/Opus or another MediaRecorder-supported codec.

Whisper should receive a format it reliably accepts. If conversion is required, normalize through a bounded local decoder path, preferably ffmpeg if Forge already treats ffmpeg as an optional dependency or a direct decoder supported by the chosen Whisper invocation.

Target normalization when necessary:

```text
mono PCM / WAV
16 kHz
```

Do not perform lossy transcode chains such as OGG -> MP3 -> WAV.

Temporary files must have:

- bounded size;
- unique names;
- cleanup on success;
- cleanup on cancellation/error;
- no execution semantics;
- no workspace write unless explicitly configured.

---

## 10. TTS: Piper

### Decision

Use Piper as the initial local TTS backend.

Greek voice:

- JOY Piper voice (`el_GR-joy-medium` / project model already available to the user).

English:

- configurable Piper English voice.

Piper should normally run on CPU. This avoids wasting VRAM needed by Qwen/Whisper and makes TTS independent of coding-model residency.

Suggested config shape:

```yaml
voice:
  tts:
    enabled: false
    backend: piper
    binary: C:/path/to/piper.exe
    language: auto
    greek_voice: C:/path/to/el_GR-joy-medium.onnx
    english_voice: C:/path/to/en_voice.onnx
    speak_code_blocks: false
```

Exact schema should follow Forge's existing config patterns.

---

## 11. The coding-vocabulary TTS problem

JOY and ordinary English Piper voices do not inherently understand programming semantics.

Raw strings such as:

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

may be spelled one character at a time, pronounced incorrectly, or produce unnatural punctuation speech.

Do not solve this by changing the visible assistant response.

Forge must maintain two representations:

```text
assistantOriginalText  -> UI/history/Telegram text
assistantSpeechText    -> Piper only
```

The speech representation is derived deterministically.

---

## 12. SpeechRenderer

`SpeechRenderer` should convert assistant Markdown into a speakable form without another LLM call for the normal case.

Suggested stages:

```text
assistant Markdown
  -> Markdown-aware segmentation
  -> code block policy
  -> inline-code/token normalization
  -> path/CLI/version/unit normalization
  -> technical pronunciation lexicon
  -> optional raw Piper phoneme injection
  -> final TTS string
```

### Deterministic transformations

Examples:

```text
exec_command       -> exec command
load_tool_group    -> load tool group
getEditorContext   -> get editor context
32GB               -> thirty two gigabytes / Greek equivalent
64k context        -> sixty four thousand context tokens, if context implies token count
--ctx-size          -> context size
src/tools/file.ts  -> file dot t s under source tools, or a shorter semantic rendering
```

The exact spoken policy should favor comprehension over literal source-code reading.

### Code blocks

Default recommendation:

- do not read full code blocks literally;
- announce or summarize structurally without an additional LLM call where possible, e.g. `I included a TypeScript code block.`;
- retain an optional `speak_code_blocks` mode for users who explicitly want literal reading.

Do not ask Qwen to make a second TTS rewrite for every answer. That adds latency, context cost, variability and another failure mode.

A future optional LLM summarization mode can be added only for very large/complex code blocks.

---

## 13. Pronunciation dictionary

Do not begin with a manually curated 1,000-entry file.

Start with:

- roughly 100-200 very common technical names;
- deterministic rules for broad token classes;
- user/workspace overrides;
- add entries based on real failed pronunciations.

Possible conceptual schema:

```json
{
  "CUDA": {
    "el_text": "κούντα",
    "en_text": "cuda",
    "el_phonemes": null,
    "en_phonemes": null
  },
  "Qwen": {
    "el_text": "κουέν",
    "en_text": "quen",
    "el_phonemes": null,
    "en_phonemes": null
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

The dictionary should be case-aware where needed but matching should normally be tolerant enough to catch common variants.

Generic rules should handle:

- snake_case;
- camelCase;
- PascalCase;
- all-caps acronyms;
- digits + units;
- model versions;
- file extensions;
- common CLI prefixes/flags;
- slash/backslash paths;
- URLs;
- Git commit abbreviations.

---

## 14. Piper pronunciation injection

Modern Piper variants support more pronunciation control than simple text replacement. Where the pinned runtime supports raw phoneme spans (for example `[[...]]` syntax), Forge can inject known phoneme sequences for technical terms while letting ordinary text use Piper/eSpeak normally.

Conceptual flow:

```text
"Restart CUDA and check the backend"
        |
        +-- ordinary words -> eSpeak phonemization
        |
        +-- CUDA -> Forge lexicon -> forced phoneme span
        |
        v
      Piper
```

This is preferable to transliteration when it works because Forge explicitly controls pronunciation rather than hoping eSpeak derives the desired pronunciation from a replacement spelling.

### Important implementation requirement

Do not assume every Piper binary/version supports the same raw-phoneme input syntax.

Before implementing this path:

1. pin/identify the Piper runtime Forge intends to support;
2. create a tiny standalone acceptance test;
3. verify JOY accepts a raw phoneme span;
4. compare synthesized output against the ordinary text path;
5. only then make raw-phoneme injection the preferred renderer.

Fallback must always exist:

```text
raw phoneme injection unavailable
  -> use el_text/en_text replacement
  -> normal eSpeak/Piper path
```

Do not edit or retrain the JOY `.onnx` merely for technical vocabulary.

---

## 15. Greek + English handling

Whisper input:

- default `language: auto` is appropriate for mixed usage;
- expose explicit `el` and `en` overrides for testing/debugging;
- never select an English-only Whisper model if Greek is enabled.

TTS output:

First implementation should avoid word-by-word switching between Greek and English Piper voices. Voice switching in a mixed technical sentence can sound more unnatural than a good pronunciation dictionary.

Preferred initial behavior:

- detect dominant response language;
- choose JOY for Greek-dominant response;
- choose configured English voice for English-dominant response;
- pronounce technical terms via lexicon/injection in that voice.

Later optional enhancement:

- language-segmented synthesis + PCM concatenation for genuinely multilingual passages.

Do not make this a Phase 1 requirement.

---

## 16. Voice output routing

The assistant response should always remain available as text.

Suggested modes:

```yaml
voice:
  output:
    sidebar: off | auto | on
    telegram: text | voice | text_and_voice
```

Recommended defaults:

- sidebar: off initially, user enables spoken output;
- Telegram: text by default; optional `text_and_voice`.

The TTS layer should consume the final assistant response after the agent turn, not intermediate tool chatter/reasoning.

Do not speak hidden thinking channels.

Do not speak raw tool-call JSON.

Do not speak every progress event.

---

## 17. Security and trust boundaries

Voice does not weaken Forge's command model.

A transcript becomes ordinary user text. It does not become a privileged command channel.

Therefore:

```text
voice -> transcript -> normal Forge user prompt -> normal agent permissions
```

All existing restrictions remain:

- tool permissions;
- normal/Clanker approval behavior;
- exec structural restrictions;
- denylist;
- recursive delete confirmation;
- remote owner/session/TOTP policy.

For Telegram, `/clanker` remains an owner command, not something STT should interpret specially unless the existing command parser receives the exact transcribed slash command and the product explicitly chooses to allow that behavior. Safer Phase 1 recommendation: voice transcriptions should be treated as prompts, not remote slash commands.

---

## 18. Failure handling

### STT failure

- do not submit partial garbage automatically;
- clean temporary audio;
- release Whisper;
- return a concise failure message;
- keep typed input available.

### Whisper OOM

Policy:

1. terminate/release failed Whisper attempt;
2. if configured, retry on CPU;
3. do not automatically evict the coding model unless an explicit policy enables it.

### TTS failure

- never fail the underlying assistant turn;
- preserve/show the text response;
- report that speech generation failed;
- clean partial audio.

### Cancellation

Voice recording, STT and TTS must all be cancellable. Cancellation must release native processes/resources and delete transient audio.

---

## 19. Configuration proposal

Conceptual only; align with current Forge schema implementation before coding:

```yaml
voice:
  enabled: true

  stt:
    backend: whisper.cpp
    binary: C:/forge/bin/whisper-cli.exe
    model: C:/forge/models/ggml-large-v3-turbo.bin
    language: auto
    prefer_gpu: true
    fallback_cpu: true
    device: auto

  tts:
    enabled: true
    backend: piper
    binary: C:/forge/bin/piper.exe
    greek_voice: C:/forge/voices/el_GR-joy-medium.onnx
    english_voice: C:/forge/voices/en_US-example.onnx
    pronunciation_mode: auto
    pronunciation_overrides: .forge/tts-pronunciations.json
    speak_code_blocks: false

  output:
    sidebar: on
    telegram: text_and_voice
```

Do not add every knob on day one. Start with the minimum fields required for a working vertical slice.

---

## 20. Implementation phases

### Phase 0 - empirical runtime checks

Before integration:

1. identify the Whisper build currently used in previous tests;
2. benchmark `large-v3`, `large-v3-turbo`, and one quantized candidate;
3. test English and Greek voice commands;
4. measure GPU/CPU memory and latency;
5. verify teardown actually releases VRAM;
6. identify the exact Piper runtime/version;
7. verify JOY command-line synthesis;
8. verify raw phoneme injection on that exact Piper runtime;
9. produce 10-20 technical pronunciation samples.

Test terms:

```text
CUDA
Qwen
GitHub
Git
Python
TypeScript
JavaScript
llama.cpp
whisper.cpp
Piper
VRAM
npm
npx
exec_command
load_tool_group
context
backend
RTX 5060 Ti
32GB
--ctx-size
```

### Phase 1 - Telegram STT vertical slice

- receive Telegram voice;
- download/store safely;
- transcribe locally;
- release Whisper;
- submit transcript through existing remote prompt path;
- no TTS yet.

This proves the most useful mobile workflow with the least UI work.

### Phase 2 - sidebar microphone

- mic control;
- recording/cancel UI;
- transfer bytes to extension host;
- same VoiceIngress + WhisperRunner;
- normal Forge prompt submission.

No separate STT implementation for sidebar vs Telegram.

### Phase 3 - basic Piper TTS

- PiperRunner;
- JOY Greek;
- English voice;
- speak plain prose;
- route to sidebar playback and/or Telegram;
- preserve original response text.

### Phase 4 - code-aware SpeechRenderer

- Markdown segmentation;
- skip/summarize code blocks deterministically;
- snake_case/camelCase/path/number/unit rules;
- initial technical lexicon;
- user override file.

### Phase 5 - Piper phoneme injection

Only after standalone validation:

- lexicon phoneme entries;
- raw-phoneme spans where supported;
- text-rewrite fallback;
- regression tests per language/voice.

### Phase 6 - polish

- output mode settings;
- language overrides;
- device/GPU selection;
- optional CPU fallback telemetry/logging;
- UX indicators;
- more pronunciation entries derived from actual usage.

---

## 21. Tests required

### Unit

- technical dictionary exact match;
- case variants;
- snake_case splitting;
- camelCase splitting;
- units/numbers;
- paths;
- Markdown/code-fence policy;
- TTS output never mutates original message;
- temporary-file cleanup;
- STT failure does not submit prompt.

### Lifecycle

- Whisper process exits after every completed transcription;
- Whisper process exits on failure;
- Whisper process exits on cancellation;
- prompt is not admitted before release barrier;
- CPU fallback occurs after GPU OOM when configured;
- coding model is not evicted by default.

### Telegram

- voice from authorized owner works;
- locked session rejects voice like text;
- non-owner voice fails closed;
- duplicate Telegram update does not run the voice prompt twice;
- TTS response follows configured output mode.

### Sidebar

- mic permission denied;
- recording cancel;
- repeated record/stop cycles;
- empty/silent recording;
- large recording limit;
- conversation switching while transcribing.

### Greek quality

Create a fixed Greek coding-command test set, not only casual speech. Example topics:

- restart backend;
- inspect CUDA error;
- run npm install;
- open TypeScript file;
- check GitHub issue;
- change context size;
- VRAM usage;
- llama.cpp flags.

Compare models using real transcription errors, not subjective memory alone.

---

## 22. Logging / observability

Keep logs metadata-focused.

Useful measurements:

- input duration;
- input codec;
- STT backend/device;
- Whisper model;
- load time;
- transcription time;
- teardown time;
- fallback used yes/no;
- transcript character count;
- TTS synthesis time;
- pronunciation replacements count;
- phoneme injections count;
- generated audio duration.

Do not log raw voice audio or full transcripts by default.

---

## 23. Non-goals for first implementation

Do not:

- make Qwen consume audio directly;
- add a new voice-specific agent loop;
- convert everything to MP3;
- keep a large Whisper model permanently resident without measurement;
- unload Qwen by default to make room for Whisper;
- retrain JOY merely to pronounce code vocabulary;
- use another LLM call to rewrite every response for TTS;
- read long source-code blocks character-by-character;
- make TTS failure fail the coding turn;
- let voice bypass Forge permissions or remote authentication.

---

## 24. Recommended first-day work order

1. Confirm current Whisper executable/model paths used in previous testing.
2. Confirm exact Piper runtime/version used with JOY.
3. Write two tiny standalone scripts/tests:
   - audio -> whisper.cpp -> transcript -> process exit;
   - text -> Piper/JOY -> WAV.
4. Test Greek Whisper with 10 coding-oriented commands.
5. Measure Whisper peak VRAM and post-exit release.
6. Validate Piper raw phoneme injection on JOY. If unsupported, lock in text-rewrite fallback.
7. Implement `VoiceIngress` + `WhisperRunner` independent of UI.
8. Wire Telegram voice into that service first.
9. Reuse the same service from the sidebar mic.
10. Add Piper only after STT input is stable.
11. Add `SpeechRenderer` and the initial technical lexicon.
12. Expand pronunciation entries from observed failures, not from speculative bulk lists.

---

## 25. Definition of done for v1

A successful v1 should demonstrate this exact loop:

```text
User records Greek or English voice in Telegram or Forge sidebar
  -> Forge transcribes locally with whisper.cpp
  -> Whisper resources are fully released
  -> transcript enters existing Forge agent loop as ordinary user text
  -> agent performs normal tool work under existing Forge security policy
  -> normal response remains visible as exact text
  -> optional SpeechRenderer creates a separate TTS representation
  -> JOY or English Piper voice speaks the response
  -> technical terms use deterministic pronunciation handling
  -> no second LLM call is required for normal TTS
```

The implementation is successful only if adding voice does not compromise Forge's existing context behavior, tool security model, remote-auth model, or coding-model VRAM stability.

---

## 26. Key design decisions to preserve

1. `whisper.cpp` is the preferred STT runtime.
2. Greek + English require multilingual Whisper checkpoints.
3. STT is transient; teardown precedes prompt submission.
4. CPU Whisper fallback is preferred to automatically evicting Qwen.
5. Piper TTS should normally stay CPU-side.
6. JOY is the first Greek TTS voice.
7. Original assistant text and spoken representation are separate.
8. Code-aware TTS normalization is deterministic code first, not an LLM prompt.
9. Piper raw-phoneme injection is preferred where verified on the pinned runtime; text normalization is the fallback.
10. Start with a modest technical lexicon plus generic rules, not a speculative 1,000-word hand-written dictionary.
11. Telegram and sidebar must share the same STT service.
12. Voice input is a normal user prompt after transcription; it receives no special execution privilege.
