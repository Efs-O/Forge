# Forge — Future Improvements

Items agreed on but not yet scheduled. Add here during review sessions, pick from here when planning the next version.

---

## UX

- **Type-while-streaming**: allow typing in the prompt box while the agent is running, but keep the Submit button disabled. Users can compose their next message while waiting instead of staring at a locked input. UI-only change — disable textarea submit, not the textarea itself.

---

## Agent / FORGE.md

- **FORGE.md hierarchy**: support multi-level FORGE.md files (workspace root → subdirectory), same pattern as Claude Code's CLAUDE.md. Useful in monorepos where sub-packages have different stacks.
- **`/initForge` model quality**: for models that still output tool-call JSON instead of raw markdown, consider a retry pass or a stricter extraction fallback.

---

## Tooling

- **`/initForge` for non-JS projects**: currently scans `package.json` and `src/`. Add detection for Python (`pyproject.toml`, `requirements.txt`), Rust (`Cargo.toml`), and Go (`go.mod`) to produce better Stack and Key Files sections.
