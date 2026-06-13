# Production-line test — `md2html` via the Forge Relay board

**This is a fleet-orchestration test, not just a product.** The goal is to prove
the Forge Relay board can drive a real, multi-backend build to a *verified* end
product — without the coordinator (SOTA) doing the bulk of the coding, and
without ending in a half-made artifact that needs heavy patching.

The anti-patch-hell mechanism: the **coordinator freezes the contract first**
(types + failing tests), then workers fill bounded bodies that are accepted only
when their tests go green. No worker invents an interface.

---

## Division of labor (read this before anything)

| Layer | Who | What |
| --- | --- | --- |
| Plan + contracts | This file | Module list, signatures, acceptance criteria |
| Skeleton + test harness | **Coordinator (Phase 0)** | Repo layout, `types.ts`, stubs, **failing tests**, build config |
| Bodies | **Fleet workers** | Fill one stub each to pass its tests |
| Integration + verify | **Coordinator (Phase 2)** | Wire pipeline, run full suite, re-dispatch reds |

Measured in LOC the bodies (the bulk) go to the fleet. Measured in difficulty the
coordinator owns the irreducible ~20% (contracts + integration). That is correct
— do **not** delegate the skeleton or the tests.

---

## Product spec — `md2html` (deliberately bounded CommonMark subset)

Zero runtime dependencies. TypeScript. Built in `prodtest-md2html/`.

**Block elements:** ATX headings (`#`..`######`), paragraphs, fenced code blocks
(` ``` `), unordered lists (`- `), ordered lists (`1. `), blockquotes (`> `),
horizontal rules (`---`), blank-line separation.

**Inline:** bold (`**x**`), italic (`*x*`), inline code (`` `x` ``), links
(`[text](url)`), and HTML-escaping of `& < >` in text (but not inside code).

**CLI:** `node dist/index.js <in.md>` → HTML to stdout; `-` reads stdin.

Out of scope (keep it bounded): tables, nested lists, images, reference links,
setext headings, HTML passthrough, autolinks.

---

## Architecture — the pipeline and its contracts

```
mdToHtml(md) = renderHtml(parseBlocks(tokenize(md)), parseInline)
```

All types live in `src/types.ts` (coordinator, Phase 0). Workers import them and
must not change them.

```ts
// src/types.ts  — OWNED BY COORDINATOR, frozen before any dispatch
export type LineKind =
  | 'heading' | 'fence' | 'ulist' | 'olist' | 'quote' | 'hr' | 'blank' | 'text';
export interface Line { kind: LineKind; raw: string; text: string; level?: number; }

export type Block =
  | { type: 'heading'; level: number; inline: string }
  | { type: 'paragraph'; inline: string }
  | { type: 'code'; content: string }
  | { type: 'list'; ordered: boolean; items: string[] }   // items = inline source
  | { type: 'quote'; inline: string }
  | { type: 'hr' };

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'strong'; value: string }
  | { type: 'em'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; text: string; href: string };
```

### Module contracts (one per worker task)

| # | File | Signature | Does |
| --- | --- | --- | --- |
| T1 | `src/tokenizer.ts` | `tokenize(input: string): Line[]` | Split into lines, classify each `LineKind`, extract `text`/`level` |
| T2 | `src/blockParser.ts` | `parseBlocks(lines: Line[]): Block[]` | Group classified lines into `Block[]` (merge paragraph runs, collect list items, fold fenced code) |
| T3 | `src/inlineParser.ts` | `parseInline(text: string): InlineNode[]` | Parse inline source → `InlineNode[]` |
| T4 | `src/renderer.ts` | `renderHtml(blocks: Block[], inline: (s: string) => InlineNode[]): string` | Render `Block[]` to an HTML string; call injected `inline` for inline-bearing blocks; escape text |

Coordinator owns: `src/types.ts`, `src/index.ts` (the `mdToHtml` pipeline + CLI),
`package.json`, `tsconfig.json`, `vitest.config.ts`, **and all test files**.

Because the types and tests are frozen in Phase 0, the four bodies have **no
interface dependency on each other** and run in parallel — each is graded only by
its own tests.

---

## Test contract (the definition of "done", authored by coordinator in Phase 0)

Each module gets `tests/<module>.test.ts` with input→output fixtures, written to
**fail** against the stubs. Plus `tests/e2e.test.ts`: 3–4 full `.md` → `.html`
fixtures exercising every block + inline kind together.

A worker task is **accepted** iff its module's test file goes green. The product
is **done** iff `npx tsc --noEmit` passes AND `npx vitest run` is fully green.

---

## Fleet composition (pinned — no auto-select, no local Ollama)

| Task | Model (id includes `@worker`) | Backend | Tier | Mode |
| --- | --- | --- | --- | --- |
| T1 tokenizer | `openrouter/free@worker` | OpenRouter (cloud) | full | async |
| T2 blockParser | `qwen3-coder:480b-cloud@worker` | Ollama cloud | full | async |
| T3 inlineParser | `gpt-oss:20b-cloud@worker` | Ollama cloud | full | async |
| T4 renderer | `qwen36-27b-q3km@worker` | **llama.cpp GGUF (local clanker)** | full | sync |

Rationale: T1–T3 are cloud (no local VRAM) and fan out in parallel; T4 is the
**one** local GGUF clanker — it exercises the llama.cpp write path, denylist, and
git checkpoint, and uses the single local VRAM slot sequentially. This is the
go-forward architecture (llama.cpp local + cloud), not a test-only carve-out.

---

## Phase plan (the board prompt drives this)

**Phase 0 — Scaffold (coordinator, no delegation).**
Create `prodtest-md2html/` with `package.json` (vitest dep only), `tsconfig.json`,
`vitest.config.ts`, `src/types.ts` (verbatim above), stub modules T1–T4 that
compile but throw `NotImplemented`, and all test files (failing). Confirm
`npx vitest run` runs and is red for the right reasons.

**Phase 1 — Dispatch bodies.**
For each of T1–T4: `claim` the target file on the board, `dispatch_subagent` with
the model/tier/mode above, giving the worker: its signature, the relevant slice
of `types.ts`, and its test file as the acceptance spec. Cloud tasks async +
parallel; the local clanker (T4) sync. On a red return, re-dispatch with the
failing assertion. `release` each claim when its tests pass.

**Phase 2 — Integrate + verify.**
Wire `src/index.ts` (`mdToHtml` + CLI), run `npx tsc --noEmit` and
`npx vitest run`. Re-dispatch any module still red. Post the final green test
summary to the board.

---

## Board discipline
- `board_check` before each dispatch; `claim` a worker's file before dispatching
  it; `release` when green — workers must not write outside their claimed file.
- Keep autonomy mode such that clanker writes are gated as configured; surface
  any denied/blocked write rather than working around it.
- Watch the cold-start window: a cloud worker's *first* call right after the
  daemon spins up may return empty — re-dispatch once before treating it as a
  real failure (known F1-adjacent behavior).

## Definition of done
1. `prodtest-md2html/` builds: `npx tsc --noEmit` clean.
2. `npx vitest run` fully green (all module tests + e2e).
3. `node dist/index.js <fixture>.md` emits correct HTML.
4. Board log shows: 4 worker dispatches, claims/releases paired, final green post.
