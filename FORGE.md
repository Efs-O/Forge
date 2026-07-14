# FORGE.md - Workspace Instructions

## Stack
TypeScript + VS Code Extension API, built with esbuild, tested with Vitest, linted with ESLint + Prettier.

## Workspace Layout
- **src/** - Core extension code, split by domain: `agent`, `backend`, `llm`, `sidebar`, `tools`, `workers`, `vscode`, `config`, `checkpoint`, `templates`, `util`
- **webview-ui/** - Webview UI components and assets
- **config/** - Runtime configuration files
- **scripts/** - Build and automation scripts
- **test/** - Test suites
- **assets/** - Static assets and resources

## Key Files
- **src/extension.ts** - Extension entry point
- **package.json** - Dependencies, scripts, and extension manifest
- **tsconfig.json** - TypeScript compiler configuration
- **config/config.example.yaml** - User-facing config example
- **esbuild.config.mjs** - Build bundler configuration
- **vitest.config.ts** - Test runner configuration
- **docs/WORKER_ORCHESTRATION_HANDOFF.md** - Current worker implementation status and next-session resume sequence

## Navigation Rules
- All extension logic lives under **src/**, organized by feature domain (backend, llm, sidebar, tools, vscode)
- Configuration files (tsconfig, eslint, prettier) live at the workspace root
- UI code for the extension webview is isolated in **webview-ui/**
- Tests mirror source structure under **test/**

## Hard Stops
- **Building .vsix packages** - Running `vsce package` or similar generates distributable extension files; confirm before executing
- **Modifying the config schema** (`src/config/schema.ts`) in a way that breaks existing `config.yaml` files - review impact before editing
