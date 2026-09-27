# Copilot CLI transport spike

**Date:** 2026-09-27  
**CLI:** GitHub Copilot CLI 1.0.88 (`@github/copilot`)  
**Decision:** GO — implement a Forge-owned observing adapter over ACP stdio

## Scope

This spike tests the transport required by
`docs/plans/COPILOT_AGENT_MESH_PLAN.md`: a Copilot CLI process owned by Forge.
It does not attempt to control an existing Copilot Chat webview or read private
VS Code extension state.

## Installation and executable resolution

The VS Code Copilot wrapper was present at:

```text
%APPDATA%\Code\User\globalStorage\github.copilot-chat\copilotCli\copilot.ps1
```

but it initially reported that GitHub Copilot CLI could not be found. The
official npm package was installed using the documented command:

```powershell
npm install -g @github/copilot
```

Environment and resolved installation:

```text
Node.js v24.11.0
npm 11.18.0
@github/copilot 1.0.88
%APPDATA%\npm\copilot.ps1
%APPDATA%\npm\node_modules\@github\copilot\node_modules\@github\copilot-win32-x64\copilot.exe
```

Forge should resolve a configured executable first and otherwise use the
documented `copilot` command. Tests must use an explicit fixture executable.
Production code must not hardcode either machine-specific path above.

Official installation reference:
https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli

## Supported transports

Two supported headless entry points were verified:

- `copilot -p <prompt>` runs one prompt and exits. `--silent` emits only the
  final text, while `--resume=<session-id>` resumes a saved CLI session.
- `copilot --acp --stdio` starts the Agent Client Protocol server. Standard
  input and output carry newline-delimited JSON; stderr remains available for
  diagnostics.

ACP is the correct production transport. It is explicitly documented for IDE
integrations and multi-agent systems and provides structured streaming,
session identity, permission requests, session loading, and cancellation.
The one-shot `-p` format is useful as a health check, but plain final text is
not enough for an observing mesh adapter.

ACP is currently public preview. The adapter therefore needs strict boundary
validation and actionable unsupported-protocol errors.

Official references:

- https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference

## Authentication and headless execution

The existing local Copilot account was already authenticated. This safe probe
completed with exit code 0 and no permission prompt:

```powershell
copilot -p "Do not use tools. Reply with exactly: FORGE_COPILOT_TRANSPORT_OK" `
  --silent --no-remote `
  --deny-tool="shell,write,web_fetch,web_search,task"
```

Observed stdout:

```text
FORGE_COPILOT_TRANSPORT_OK
```

Forge must not store or copy Copilot credentials. Missing or expired
authentication remains a CLI error surfaced to the user. `--no-remote` should
be applied so a Forge-owned local mesh turn does not silently become a remotely
controlled GitHub session.

## Live ACP probe

The protocol probe used the official `@agentclientprotocol/sdk` in a temporary
directory; it did not add a Forge dependency or edit the repository. It:

1. spawned `copilot --acp --stdio --no-remote`;
2. initialized ACP version 1;
3. created a session in the Forge workspace;
4. streamed a marker answer;
5. stopped that owned process;
6. spawned a fresh ACP process and loaded the recorded session id;
7. streamed a second marker answer; and
8. started a long response, sent `session/cancel`, and awaited its terminal
   result.

Redacted result:

```json
{
  "protocolVersion": 1,
  "agentInfo": {
    "name": "Copilot",
    "version": "1.0.88"
  },
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": {
      "image": true,
      "embeddedContext": true
    },
    "sessionCapabilities": {
      "close": {},
      "list": {}
    }
  },
  "sessionId": "<redacted-uuid>",
  "first": {
    "stopReason": "end_turn",
    "text": "ACP_FIRST_OK"
  },
  "resume": {
    "stopReason": "end_turn",
    "text": "ACP_RESUME_OK"
  },
  "cancel": {
    "stopReason": "cancelled"
  },
  "stderr": ""
}
```

The real stream also emitted structured informational session updates for
excluded tool names before the answer. Production parsing must treat ACP
`session/update` variants as typed status or content events, not concatenate
every textual update into the final answer. Only `agent_message_chunk` content
belongs in `finalText`.

## Session and process design

Use one ACP stdio child per active Forge-owned Copilot session, with the child
lifetime owned by the session adapter. Persist only the confirmed ACP session
id needed by the existing mesh ownership/alias mechanism. On extension reload
or process loss, start a fresh owned ACP child and call `session/load` with that
id. A failed load is `context_lost`; it must not silently create a new session.

This shape gives Forge correlated streamed lifecycle events and direct
`session/cancel`, while still surviving extension-host reload through the CLI's
durable session store. Closing stdin or terminating the child is a fallback
only for crash/timeout/dispose after the cancel grace period, and may target
only the process Forge spawned.

## Workspace and native tools

ACP `session/new` and `session/load` both take an absolute `cwd`. The process
must also be spawned with that workspace as its working directory.

Tool visibility and reasoning options are fixed when the ACP server starts.
Copilot documents `--available-tools` and `--excluded-tools` for restricting
the model, plus allow/deny permission controls for headless use. The production
full-access policy should use the installed CLI's documented allow-all option,
matching the intent of the owned Codex path, and must be covered by argv tests.
Forge's existing delegation confirmation still gates whether the Copilot turn
starts.

Official permission reference:
https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools

## Errors and required adapter behavior

The ACP boundary must distinguish:

| Condition | Required result |
| --- | --- |
| executable missing | actionable unavailable error; no fallback agent |
| unauthenticated or policy-disabled | surface sanitized CLI/protocol error |
| quota/rate limit | terminal failure with sanitized diagnostic |
| malformed/non-JSON stdout | protocol failure and owned-child cleanup |
| child crash | terminal failure; preserve confirmed session id for recovery |
| timeout | send ACP cancel, wait a bounded grace period, then stop owned child |
| explicit steer/cancel | send ACP cancel and require terminal settlement before next FIFO item |
| `session/load` failure | emit `context_lost`; do not claim continuity |
| unknown protocol version/update | fail loudly at the validation boundary |

These failure paths require hermetic fixture coverage. Live authentication and
quota failures were not induced because doing so would mutate account state or
consume an uncontrolled allowance; the remaining live-system risk is called
out for P4 validation.

## P0 conclusion

The transport is technically suitable for Copilot as a first-class Forge mesh
peer. The decisive evidence is structured ACP stdio, a confirmed durable
session id that loaded in a second process, streamed correlated answer events,
and an observed cancellation terminal state.

Proceed with the P1 ACP driver and owned-session lifecycle. Before committing
that slice, remove the unrelated uncommitted inbound VS Code
`languageModelTools` implementation identified in the plan. Do not retain the
old `COPILOT_TRANSPORT_SPIKE.md` conclusion as the peer-transport decision; it
investigated a different direction.
