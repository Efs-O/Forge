# Resident whisper server — plan

Status: **proposed**, not implemented. Written 2026-09-04.

Owner concern: STT process lifecycle. Related: `docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md`
§6.1b (why whisper.cpp), §2.4 (why residency defaults off).

---

## 1. The problem, measured

`voice.keep_model_loaded` has existed since the voice feature shipped and **does
nothing**. It is declared in `src/config/schema.ts` and `src/config/types.ts` and
read by nothing — `grep` finds two definitions and zero consumers. This is the
exact shape CLAUDE.md's Single Point of Truth section warns about: the wired half
of a bug pointing at itself. Anyone who set it to `true` believed they had turned
on residency and got the cold path anyway.

`WhisperCppRunner` spawns `whisper-cli` once per utterance, so every voice note
pays a full model load. Measured on this machine, `ggml-large-v3.bin` on CUDA0:

| phase | time |
| --- | --- |
| model load | **5531 ms** |
| mel | 4 ms |
| encode | 185 ms |
| sample + batched decode | 119 ms |
| **total** | **5885 ms** |

So **94% of the wall clock of a short voice note is model load**, and the fixed
cost does not shrink for a two-second note. The §6.1b figures (~4.2 s cold,
~250 ms warm) are confirmed and if anything conservative — this build is slower
to load and faster to decode.

This is also the only reason `RemoteVoiceBridge` sends `"Forge: transcribing
voice…"` before running: the sender needs proof they were heard during a delay
that is almost entirely avoidable.

## 2. What already exists

- `whisper-server` **is** in whisper.cpp's tree, and the local build has
  `WHISPER_BUILD_SERVER:BOOL=ON` in its CMakeCache — the target was configured
  and simply never built. `cmake --build build --config Release --target
  whisper-server` produced a working `whisper-server.exe` in ~40 s with no
  reconfiguration. **This is not a fork or a patch.**
- It takes the same device flags as `whisper-cli`: `-ng`, `-dev N`, `-t`, `-bs`,
  `-fa`/`-nfa`. So `voice.compute:` maps onto it unchanged, and the three-GPU
  layout works the same way in both modes.
- `POST /inference`, multipart, field `file` plus optional `language`, `prompt`,
  `response_format`, `temperature`. With `response_format=text` the body is plain
  transcript text — **byte-identical in shape to the `whisper-cli` stdout the
  current runner already parses**, so `TranscriptAcceptance` and everything
  downstream are untouched.
- `GET /` returns the server's HTML page. There is no `/health`, so that is the
  readiness probe.
- `EmbeddingBackend` (238 LOC) is the same problem already solved once: spawn a
  second inference process, wait for healthy, refcount active work, unload after
  an idle timeout, confirm with the user before taking VRAM, dispose on
  deactivate. This plan follows it deliberately rather than inventing a second
  supervision style.

## 3. Design

### 3.1 Config

Replace the dead boolean with a block that says what it actually does. The
existing key becomes a **hard validation error**, not a silent migration:

```yaml
voice:
  server:
    # Hold whisper resident behind a local HTTP server instead of spawning
    # whisper-cli per utterance. ~5.5 s -> ~0.3 s per note, at ~3.6 GB VRAM.
    enabled: false
    # whisper-server.exe. Build it with:
    #   cmake --build build --config Release --target whisper-server
    binary: C:/tools/whisper.cpp/build/bin/Release/whisper-server.exe
    port: 8092
    # Unload after this long with no voice traffic. 0 keeps it resident forever.
    idle_timeout_ms: 600000
    # Ask before taking the VRAM, like embeddings does.
    confirm_on_start: true
```

`voice.keep_model_loaded` gets a Zod refinement that rejects it with
`"voice.keep_model_loaded never worked and has been replaced by voice.server.enabled"`.
Silently accepting a key that lied for two releases would preserve the lie;
`ConfigLoader` already has precedent for this in the `worker` removal notice.

`port` needs a default distinct from `embeddings.port` (8091) and the control
server (8799). 8092.

### 3.2 New files

| file | LOC (est.) | role |
| --- | --- | --- |
| `src/voice/WhisperServerRunner.ts` | ~110 | `WhisperRunner` over `POST /inference`. Multipart via `FormData`/`Blob` from the audio file, `response_format=text`, maps HTTP failure and abort onto `VoiceTranscriptionError` with the same reason codes the CLI runner uses. |
| `src/voice/WhisperServerProcess.ts` | ~170 | Lifecycle. Spawn, `waitForHealthy` on `GET /`, activity refcount, idle unload, `dispose()`. Modelled on `EmbeddingBackend`. |
| `test/unit/WhisperServerRunner.test.ts` | ~120 | Request shape and error mapping against a stub HTTP handler. |
| `test/unit/WhisperServerProcess.test.ts` | ~120 | Readiness timeout, idle unload, refcount holds the process through a slow transcription, dispose kills. |

### 3.3 Wiring

`buildVoiceBridge()` in `src/remote/RemoteVoiceBridge.ts` picks the runner:

```
voice.server.enabled ? new WhisperServerRunner(...) : new WhisperCppRunner(...)
```

`WhisperRunner` is already the seam — `VoiceIngress` takes the interface, not the
class — so nothing above the runner changes. That interface existing is what
makes this a substitution instead of a refactor.

Two things must be threaded that the CLI path does not need:

1. **Disposal.** The process must land in `context.subscriptions` so a window
   close does not orphan a 3.6 GB process. `buildVoiceBridge` currently returns
   `{ bridge, drafts }` and has no disposable channel; it grows one. This is the
   single largest source of risk in the change — an orphaned whisper-server
   holding VRAM is worse than a slow cold start, and `docs/plans` already records
   an orphaned `:8799` control server as a real incident.
2. **Activity scope.** `withActivity()` must wrap the whole `ingress.run`, not
   just the HTTP call, or the idle timer can fire between normalization and
   inference.

### 3.4 Deliberately out of scope

- **Piper residency.** Piper's cost is per-call process start on a ~60 MB ONNX
  model, not a 3 GB load. Not worth a supervisor.
- **A second model on a second port.** One resident server, one model.
- **Adopting an externally started whisper-server.** `EmbeddingBackend` has
  `ownsProcess` for this; adding it here means a served-model probe whisper-server
  does not offer. Forge spawns it or uses the CLI.
- **Dropping `WhisperCppRunner`.** The CLI path stays the default. It has no
  resident VRAM cost, and on a single-GPU machine that is the right trade.

## 4. Risks

- **VRAM contention is the whole tension.** 3.6 GB resident is 22% of the 16 GB
  card. On this machine that is what the third GPU is for, and until the 3060 is
  dedicated, `voice.server.enabled: true` plus `compute.device: 1` competes with
  the 131K q8_0 KV cache llama.cpp currently spans both cards for. The plan does
  not resolve that; `confirm_on_start` and `idle_timeout_ms` make it the user's
  visible choice, which is the same answer embeddings landed on.
- **The user must build one binary.** Unavoidable and already true of
  `whisper-cli`. The config comment carries the exact cmake line, and a missing
  binary must fail naming `voice.server.binary`, per the existing
  `assertReadable` pattern.
- **Orphaned process.** See 3.3.1. The dispose test is not optional coverage.
- **A stale resident model after a config change.** Changing `whisper_model` or
  `compute.device` while the server is up must restart it.
  `EmbeddingBackend.currentSignature` is the existing answer — hash the argv,
  restart on change.

## 5. Estimate

~400 LOC of source plus ~240 of tests, five files touched, one new config block,
one breaking config rejection. Two to three hours including the dispose and
restart-on-signature-change tests, which are where the real bugs live.

Not "small". The mechanism is a copy of a pattern already in the tree, but the
failure mode is a leaked multi-gigabyte GPU process, and that earns its tests.

## 6. Sequence

1. Reject `voice.keep_model_loaded`; add `voice.server` to schema, types, example
   config. Ship the rejection first so nobody keeps believing the old key.
2. `WhisperServerRunner` + tests against a stub server. No process yet.
3. `WhisperServerProcess` + tests. Fake spawn.
4. Wire into `buildVoiceBridge`, thread disposal to `context.subscriptions`.
5. Live check: one Telegram voice note cold, one warm. Confirm warm is
   sub-second, confirm the process dies on window close and after the idle
   timeout, confirm `nvidia-smi` shows the VRAM returned.
