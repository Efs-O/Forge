# Voice-Reply Toggle Command Plan

Add a remote chat command — `/voice on|off|status` — that turns spoken
Telegram replies on or off at runtime, without editing `.forge/config.yaml` by
hand.

## Background

Spoken replies are gated by `voice.output.enabled` in config. The schema
default is `false` (`src/config/schema.ts`, `VoiceConfigSchema.output.enabled`
→ `z.boolean().default(false)`), so the flag is a config/schema matter, not a
code defect: when it is off, `buildSpeechDelivery` returns `undefined`
(`src/remote/RemoteSpeechDelivery.ts`) and `RemoteController` sends text only.
Today the only way to change it is to hand-edit `config.yaml` and reload the
window.

The user asked for a chat command to flip it, mirroring the existing
`/notify` and `/mirror` toggles.

## Design decision: persist to `config.yaml`, not in-memory

`/notify` and `/mirror` are per-chat, in-memory, and *deliberately* do not
survive a window reload (their reply text says so). A voice toggle is
different in two ways:

1. **It is global, not per-chat.** `buildSpeechDelivery` reads
   `config.voice.output.enabled` and builds one delivery service per
   transport, not per chat. There is no per-chat voice state to hold.
2. **It is a capability, not a volume knob.** Speech is a configured
   capability (Piper binary + voices dir must exist) that the user expects to
   stay in the state they last set. A reload that silently re-enables voice
   the user just turned off is a surprise.

So the command should **write `voice.output.enabled` back to `config.yaml`**
and then apply it in-memory, so it survives reload and matches the file the
user would otherwise edit by hand. The write path already exists and is the
single sanctioned one: `ConfigWriter.updateConfigFile`
(`src/config/ConfigWriter.ts`), which loads the document, lets a callback
mutate the live node graph, validates against `ForgeConfigSchema`, and
atomically replaces the file (temp + rename, `.bak` backup). Comments and key
order on untouched keys survive.

The in-memory apply is the same mutation the loader would produce: set
`config.voice.output.enabled = <bool>` on the shared `ForgeConfig` and call
`remoteRuntime.applyConfig(config)`, which tears down and rebuilds the active
transports (re-running `buildSpeechDelivery`). This reuses the existing
reconfig path instead of reaching into the controller's private speech field.

### Why not just flip the in-memory flag and skip the file write?

Because `config.yaml` is the source of truth the user reads and edits. A
runtime-only flip would diverge from the file, and the next reload would
revert it — the exact surprise we are trying to remove. Writing the file keeps
the two in agreement and makes the change durable and inspectable.

## Changes

### 1. `src/config/ConfigWriterHelpers.ts` — nested-key setter

`setTopLevel` only handles top-level keys. We need to set one field on the
`voice.output` sub-map, preserving the rest of the `voice:` block (whisper
paths, compute, input, etc.). Add a focused helper:

```ts
/**
 * Set (or delete, when `value === undefined`) a single field on a nested
 * object block, e.g. `voice.output.enabled`. Lazily creates the intermediate
 * maps so a config that never had an `output:` block still gains one.
 * Preserves comments/formatting on sibling keys.
 */
export function setNestedField(
  doc: YAML.Document,
  pathKeys: readonly string[],
  value: unknown,
): void {
  let node: YAML.YAMLMap = doc.contents as YAML.YAMLMap;
  for (let i = 0; i < pathKeys.length - 1; i++) {
    const key = pathKeys[i];
    let next = node.get(key, true);
    if (!next || !YAML.isMap(next)) {
      next = doc.createNode({}) as YAML.YAMLMap;
      node.set(key, next);
    }
    node = next;
  }
  const last = pathKeys[pathKeys.length - 1];
  if (value === undefined) node.delete(last);
  else node.set(last, doc.createNode(value));
}
```

Export it alongside the other helpers.

> **As shipped:** the implementation hardens the snippet above with an
> empty-path guard (`throw` on `pathKeys.length === 0`) and a non-map / empty
> document root (creates the root map instead of assuming `doc.contents` is a
> `YAMLMap`). Both edge cases are covered by `setNestedField` unit tests in
> `test/unit/ConfigWriterDocument.test.ts` ("works on a document whose root is
> empty", empty-path throw).

### 2. `src/remote/RemoteCommandContext` — a voice toggle capability

In `src/remote/RemoteCommandHandler.ts`, add an optional capability to
`RemoteCommandContext`, shaped like `notifyMute`/`mirrorToggle` but global:

```ts
/** Global spoken-reply toggle, persisted to config.yaml. */
voiceToggle?: {
  get: () => boolean;
  set: (on: boolean) => Promise<void>;
} | undefined;
```

`get` reads the live value; `set` writes the file and applies in-memory.

### 3. `src/remote/RemoteSessionCommands.ts` — the `/voice` branch

Add a branch in `handleRemoteSessionCommand`, before the final `return
undefined`, modelled on `/mirror`:

```ts
if (command === '/voice') {
  if (!context.voiceToggle) {
    return { kind: 'rejected', reason: 'spoken replies are not available in this window' };
  }
  const desired = argument?.toLowerCase();
  if (desired !== 'on' && desired !== 'off' && desired !== undefined && desired !== 'status') {
    return { kind: 'rejected', reason: 'usage: /voice on|off|status' };
  }
  if (desired === 'on' || desired === 'off') {
    try {
      await context.voiceToggle.set(desired === 'on');
    } catch (err) {
      return {
        kind: 'rejected',
        reason: `could not update voice setting: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const on = context.voiceToggle.get();
  await context.channel.send(
    event.chatId,
    on
      ? 'Forge: spoken replies ON — replies are also sent as a voice message. Saved to config.yaml.'
      : 'Forge: spoken replies OFF — replies are text only. Saved to config.yaml.',
    { signal: context.signal },
  );
  return { kind: 'handled' };
}
```

Also add `/voice on|off` to the `/help` command list (the `Session:` line) and
a Notes bullet explaining it persists to `config.yaml`.

### 4. `src/remote/RemoteCommandHandler.ts` — wire the capability

`handleRemoteCommand` is called from `RemoteController` with a context object.
The `voiceToggle` capability must be threaded through from the controller, which
in turn gets it from `RemoteRuntime`. See step 5 for where the runtime builds
it.

### 5. `src/remote/RemoteRuntime.ts` — build and pass the capability

`RemoteRuntime` needs the config file path to write it. It already receives
`storageDirectory` (global storage) in `RemoteRuntimeOptions`; the config path
is a *workspace* path (`.forge/config.yaml`), so add it to the options:

```ts
export interface RemoteRuntimeOptions {
  // ...existing...
  /** Absolute path to `.forge/config.yaml`, for persisted toggles. */
  configPath?: string | undefined;
}
```

In `extension.ts`, where `RemoteRuntime` is constructed
(`src/extension.ts`, `new RemoteRuntime({...})`), pass
`configPath: activeConfigPath` (already in scope at that call site).

In `RemoteRuntime`, expose a method that performs the write + apply:

```ts
/** Persist `voice.output.enabled` to config.yaml and rebuild transports. */
async setVoiceOutput(on: boolean): Promise<void> {
  if (!this.options.configPath) throw new Error('config path is not available');
  updateConfigFile(this.options.configPath, (doc) =>
    setNestedField(doc, ['voice', 'output', 'enabled'], on),
  );
  // Re-read so the in-memory ForgeConfig matches the file, then rebuild.
  const config = loadConfig(path.dirname(this.options.configPath!));
  this.appliedConfig = config;
  await this.replace(config);
}
```

`updateConfigFile` already validates against the schema before writing, so a
malformed mutation cannot corrupt the file. `replace` (already used by
`applyConfig`) tears down and rebuilds the active transports, re-running
`buildSpeechDelivery` against the new flag.

New imports required in `RemoteRuntime.ts` (the snippets above omit them):

```ts
import * as path from 'path'; // already imported
import { loadConfig } from '../config/ConfigLoader';
import { updateConfigFile } from '../config/ConfigWriter';
import { setNestedField } from '../config/ConfigWriterHelpers';
```

Then, where the controller is constructed (the `RemoteController` call in
`RemoteRuntime`), pass:

```ts
voiceToggle: {
  get: () => this.appliedConfig?.voice?.output?.enabled === true,
  set: (on) => this.setVoiceOutput(on),
},
```

### 6. `src/remote/TelegramChannel.ts` — native command menu

Add the entry to `TELEGRAM_BOT_COMMANDS` (alphabetical, matching the existing
list):

```ts
{ command: 'voice', description: 'Spoken replies on/off' },
```

This is cosmetic (native menu); parsing is transport-independent and already
handled by the `/voice` branch.

## Files touched

| File | Change |
| --- | --- |
| `src/config/ConfigWriterHelpers.ts` | Add `setNestedField` + export |
| `src/remote/RemoteCommandHandler.ts` | Add `voiceToggle` to context type |
| `src/remote/RemoteSessionCommands.ts` | Add `/voice` branch + `/help` line |
| `src/remote/RemoteRuntime.ts` | Add `configPath` option, `setVoiceOutput`, wire capability |
| `src/extension.ts` | Pass `configPath: activeConfigPath` to `RemoteRuntime` |
| `src/remote/TelegramChannel.ts` | Add `voice` to `TELEGRAM_BOT_COMMANDS` |

## Tests

- **Unit — `setNestedField`** (`test/unit/`): set on an existing
  `voice.output` block; create the block when absent; delete when value is
  `undefined`; assert sibling keys and a hand-written comment on an untouched
  key survive (round-trip through `updateConfigFile` on a temp file).
- **Unit — `/voice` branch** (`test/unit/`): with a stub
  `voiceToggle`, `/voice on` calls `set(true)` and replies ON; `/voice off`
  calls `set(false)`; `/voice status` (or bare `/voice`) replies without
  calling `set`; `/voice bogus` → rejected with usage; `voiceToggle` absent →
  rejected "not available".
- **Integration — persistence** (`test/integration/RemoteVoiceToggle.test.ts`):
  point `configPath` at a temp `.forge/config.yaml` with
  `voice.output.enabled: true`, run `setVoiceOutput(false)`, re-load the file,
  assert it is now `false` and that `replace` was invoked (transports rebuilt)
  with the re-loaded config. Also asserts sibling keys + hand-written comments
  survive, that `voice.enabled` (STT) is untouched, and that a missing
  `configPath` throws "config path is not available".

## Non-goals

- No new CLI/VS Code command; this is a remote chat command only.
- No per-chat voice state; the toggle is global by design.
- No change to the STT ingress (`voice.enabled`) — only the TTS output
  (`voice.output.enabled`) is toggled.

## Acceptance criteria

- [ ] `voice.output.enabled` schema default remains `false`; the command does
      not change the default, only the user's stored value.
      *Validation: `test/unit` schema test asserting the default, plus the
      `/voice` unit tests.*
- [x] `/voice off` writes `voice.output.enabled: false` to `config.yaml`
      **and** stops spoken replies without a window reload.
      *Validation: integration test (file re-read) + manual Telegram run.*
- [x] `/voice on` does the reverse; a window reload after either keeps the
      state the user last set (persistence).
      *Validation: integration test asserting the file value survives a
      re-load; manual reload check.*
- [x] Untouched config keys and hand-written comments survive the write
      (comment-preserving writer).
      *Validation: `setNestedField` round-trip unit test + integration test raw
      re-read.*
- [ ] A schema-invalid mutation writes nothing and returns a `rejected`
      disposition with the error message (no partial/corrupt file).
      *Validation: unit test forcing an invalid value; assert file unchanged.*
      **Not yet covered by a dedicated test** — the guard exists
      (`updateConfigFile` runs `ForgeConfigSchema.parse` before writing), but no
      test forces an invalid value and asserts the file is unchanged.*
- [x] `/voice` with no `configPath` wired (e.g. a window without a resolvable
      config) is rejected with a clear "not available" reason, not a crash.
      *Validation: unit test with `voiceToggle` absent, plus integration test
      asserting `setVoiceOutput` throws when `configPath` is missing.*
- [x] Bare `/voice` and `/voice status` report the current state without
      mutating the file.
      *Validation: unit test asserting `set` is not called.*
- [x] `voice` appears in the Telegram native command menu and in the `/help`
      output.
      *Validation: code review of `TELEGRAM_BOT_COMMANDS` + `/help` string;
      manual Telegram menu check.*
- [x] The STT ingress (`voice.enabled`) is not affected by `/voice`.
      *Validation: integration test asserting the write leaves `voice.enabled`
      true while flipping `voice.output.enabled`.*
