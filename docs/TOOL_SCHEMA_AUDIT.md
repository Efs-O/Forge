# Local tool-schema audit

Contributor tooling: an opt-in harness that asks a local model to emit tool
calls without executing any handler. Moved off `README.md` because vitest
environment variables are not something a Marketplace visitor is reading for.

The generated coverage matrix it produces is [TOOL_COVERAGE.md](TOOL_COVERAGE.md).

Forge includes an opt-in local-model harness whose inventory is built by
bundling and running `registerAllTools.ts` with a maximal synthetic config.
The registry's advertised definitions are captured after every permission and
lazy group is enabled, so schemas include evaluated constants and loop-registered
families. The harness asks the configured model to emit calls but does not
execute handlers or side effects.

```powershell
npm run test:local-tools -- --list
npm run test:local-tools -- --base-url http://127.0.0.1:8080 --strict-args
```

`--strict-args` uses structural comparison, so JSON object-key order is
irrelevant while array order remains significant. External MCP processes are
never started by default. Use `--include-mcp` explicitly (and optionally
`--config <path>`) to include configured MCP schemas in the inventory or model
sweep. Reports identify native versus MCP tools and state that the mode is
schema emission only. “Schema-valid” includes the schema's structural rules and
its numeric, string-length, and array-length bounds.

Generate the canonical native coverage matrix by merging dated evidence:

```powershell
npm run test:local-tools -- --list `
  --coverage-report docs/TOOL_COVERAGE.md `
  --model-evidence docs/live-reports/<dated-tool-report>.json `
  --capability-evidence docs/live-reports/<dated-capability-report>.json
```

Add `--include-mcp` for a local, configuration-dependent MCP inventory. The
coordinator, delegation, vision, and semantic-search checks are
hardware-dependent and skipped in ordinary CI. Run them explicitly against a
local model and embedding endpoint:

```powershell
$env:FORGE_LIVE_CAPABILITIES = '1'
$env:FORGE_LIVE_ENDPOINT = 'http://127.0.0.1:8080'
$env:FORGE_LIVE_EMBEDDING_ENDPOINT = 'http://127.0.0.1:8091'
$env:FORGE_LIVE_MODEL = '<configured-model-name>'
$env:FORGE_LIVE_REPORT = 'docs/live-reports/capabilities-YYYY-MM-DD-HHMM.json'
npx vitest run test/live/GemmaCapabilities.live.test.ts --reporter=verbose
```
