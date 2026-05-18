# 12 — Release & Publish

How to build, package, and ship Forge to end users — GitHub Releases and the
VS Code Marketplace (+ Open VSX for Cursor/Codium compatibility).

---

## Prerequisites (one-time setup)

### Publisher account
1. Create a publisher at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
2. Publisher ID goes into `package.json` → `"publisher": "efs-o"` (or chosen ID)
3. Create a Personal Access Token (PAT) in Azure DevOps:
   - Organisation: `All accessible organizations`
   - Scope: **Marketplace → Manage**
   - Store it in a GitHub Actions secret: `VSCE_PAT`

### Open VSX (Cursor / Codium)
1. Create account at [open-vsx.org](https://open-vsx.org)
2. Generate a token, store as GitHub Actions secret: `OVSX_PAT`

### Local tools
```bash
npm install -g @vscode/vsce ovsx
```

---

## Repository layout for packaging

Files included in the `.vsix` are controlled by `.vscodeignore`. Everything
listed there is **excluded**. The `.vscodeignore` must exclude:

```
# Dev / planning — never ship
docs/**
legacy/**                    # llamabridge reference — must be gone before publish
.claude/**
.cursor/**
test/**
**/*.test.ts
**/*.spec.ts
coverage/**
.github/**
esbuild.config.mjs
tsconfig.json
*.md
!README.md                   # README ships; all other .md files do not

# Source — only the compiled bundle ships
src/**
webview-ui/src/**
webview-ui/node_modules/**

# Dev deps (node_modules ships only runtime deps — see Bundling below)
node_modules/**
```

### Bundling — why `node_modules` is excluded

Forge uses **esbuild** to produce a single `dist/extension.js` bundle
(extension host) and a separate `dist/webview.js` bundle. Both bundles inline
all runtime dependencies. The `.vsix` therefore contains only:

```
dist/extension.js
dist/webview.js
package.json
README.md
LICENSE
.forge/config.yaml
```

No `node_modules/` in the package. `vsce` will warn if you ship
`node_modules/` — treat that warning as an error.

---

## Build pipeline

### 1. Install dependencies
```bash
npm ci
```

### 2. Build webview
```bash
npm run build:webview        # produces dist/webview.js
```

### 3. Bundle extension host
```bash
npm run build:ext            # esbuild → dist/extension.js
```

Or both together:
```bash
npm run build                # runs build:webview + build:ext
```

### 4. Run tests
```bash
npm run test                 # vitest unit tests
npm run test:integration     # @vscode/test-electron (requires display)
```

### 5. Type check
```bash
npm run type-check           # tsc --noEmit
```

All five steps must pass before packaging.

---

## Version bumping

Version lives in `package.json` → `"version"`. Follow semver.

```bash
# Patch (bug fix)
npm version patch            # e.g. 0.5.0 → 0.5.1

# Minor (new feature, backwards-compatible)
npm version minor            # e.g. 0.5.1 → 0.6.0

# Major (breaking change or first stable)
npm version major            # e.g. 0.9.x → 1.0.0
```

`npm version` updates `package.json` and creates a git tag (`v0.6.0`).
Push the tag:

```bash
git push && git push --tags
```

The tag push triggers the GitHub Actions release workflow (see below).

---

## Pre-publish checklist

Run this checklist before every release, in order:

- [ ] All lift-list items for this version are ported to `src/` (see [10-bridge-audit.md §6](10-bridge-audit.md))
- [ ] `legacy/llamabridge/` deleted from the repo (v1.0 and beyond — see removal plan in [10-bridge-audit.md §9](10-bridge-audit.md))
- [ ] `.forge/config.yaml` reflects the current supported schema
- [ ] `README.md` updated — Path A and Path B documented, install instructions current
- [ ] `package.json` `"version"` bumped, `"publisher"` set, `"engines.vscode"` pinned correctly
- [ ] `CHANGELOG.md` updated with this version's changes
- [ ] License file present (`LICENSE`) and `package.json` `"license"` field set
- [ ] `.vscodeignore` verified — `legacy/`, `docs/`, `test/`, source maps excluded
- [ ] `npm run build && npm run test && npm run type-check` all green
- [ ] `vsce ls` run to inspect package contents — no secrets, no Python files, no docs
- [ ] No API keys or secrets in any tracked file (`vsce package` will warn; treat as error)

---

## Local packaging (smoke test before CI)

```bash
vsce package
```

Produces `forge-<version>.vsix` in the repo root.

Install locally to verify:
```bash
code --install-extension forge-<version>.vsix
```

Test the golden paths:
1. Extension activates, sidebar appears
2. Path A: `llama-server` detected or first-run wizard shown
3. Ask mode: message sent, streaming response received
4. Config error surfaces correctly in sidebar

---

## GitHub Actions workflows

### `ci.yml` — runs on every push and PR

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  build-and-test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run type-check
      - run: npm run test
        env:
          DISPLAY: ':99'           # Linux headless display for @vscode/test-electron
```

CI runs on **all three platforms** on every push. A red CI on any platform
blocks merge.

### `release.yml` — runs on version tag push

```yaml
name: Release
on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write            # needed to create GitHub Release

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci
      - run: npm run build
      - run: npm run type-check
      - run: npm run test

      # Package VSIX
      - run: npx vsce package --no-dependencies
      - name: Get VSIX filename
        id: vsix
        run: echo "file=$(ls *.vsix)" >> $GITHUB_OUTPUT

      # GitHub Release — attaches .vsix as a download artifact
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: ${{ steps.vsix.outputs.file }}
          generate_release_notes: true

      # Publish to VS Code Marketplace
      - name: Publish to Marketplace
        run: npx vsce publish --no-dependencies --packagePath ${{ steps.vsix.outputs.file }}
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}

      # Publish to Open VSX (Cursor / Codium)
      - name: Publish to Open VSX
        run: npx ovsx publish ${{ steps.vsix.outputs.file }} -p ${{ secrets.OVSX_PAT }}
```

The single workflow does three things atomically: GitHub Release with
`.vsix` attached, Marketplace publish, Open VSX publish. If any step fails,
the tag stays but the failed target can be re-run manually.

---

## GitHub Release

Each tag push produces a GitHub Release at
`https://github.com/Efs-O/Forge/releases` with:

- Auto-generated release notes (from commit messages since last tag)
- `forge-<version>.vsix` attached as a downloadable artifact

This lets users install without the marketplace:
```bash
code --install-extension forge-<version>.vsix
```

This is the install path for:
- Users behind corporate proxies that block marketplace
- Cursor users until Open VSX is live
- Anyone wanting a specific older version

---

## VS Code Marketplace

Published at:
`https://marketplace.visualstudio.com/items?itemName=efs-o.forge`

Users install via:
```bash
ext install efs-o.forge
```

Or via the Extensions panel search.

**Marketplace review:** Microsoft auto-scans for malware; first publish may
take up to 24h for review. Subsequent publishes are usually instant.

### `package.json` marketplace fields (required)

```jsonc
{
  "name": "forge",
  "displayName": "Forge",
  "description": "Local-LLM coding assistant — direct llama.cpp, strict tool schemas, three modes",
  "version": "0.1.0",
  "publisher": "efs-o",
  "license": "Apache-2.0",
  "engines": { "vscode": "^1.90.0" },
  "categories": ["AI", "Chat", "Other"],
  "keywords": ["llm", "llama.cpp", "local ai", "coding assistant", "agent"],
  "icon": "assets/icon.png",              // 128×128 PNG, required
  "repository": {
    "type": "git",
    "url": "https://github.com/Efs-O/Forge"
  },
  "bugs": { "url": "https://github.com/Efs-O/Forge/issues" },
  "homepage": "https://github.com/Efs-O/Forge#readme",
  "galleryBanner": {
    "color": "#1e1e1e",
    "theme": "dark"
  }
}
```

The `icon` field is mandatory for marketplace listing. A missing icon
causes `vsce publish` to warn; the listing will show a blank tile.

---

## Open VSX (Cursor / Codium)

Open VSX is the alternative registry used by VS Code forks that cannot access
Microsoft's marketplace. Publishing there gives Cursor users a one-click
install without waiting for post-v1.0 Cursor compatibility work.

Published at: `https://open-vsx.org/extension/efs-o/forge`

The `release.yml` workflow publishes to both registries from the same `.vsix`.
No separate build needed.

---

## Post-publish steps

After a successful release:

1. Verify the marketplace listing renders correctly (icon, description, README)
2. Do a clean install from the marketplace on each platform (Win/Mac/Linux)
3. Close the milestone in GitHub Issues for this version
4. Open the next milestone
5. Post release note to wherever users congregate (HN, X, Reddit r/LocalLLaMA)

---

## Hotfix process

For critical bugs discovered post-publish:

1. Branch from the release tag: `git checkout -b hotfix/v0.5.1 v0.5.0`
2. Fix the bug, add a test
3. `npm version patch` → push branch + tag
4. Tag push triggers `release.yml`
5. Merge the fix back to `main`

Do **not** amend published tags. Always create a new patch version.
