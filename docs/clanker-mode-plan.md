# Clanker Mode — Implementation Plan

Full-auto tool approval bypass for Forge. The agent stops asking for confirmation
on every write/terminal/git tool call. Dangerous operations (recursive delete) still
always confirm. State is global across all conversations, lives until VS Code exits.

---

## Dead Code Removal

| File | Action | Reason |
|------|--------|--------|
| `src/tools/ConfirmationGate.ts` | **Delete** | VS Code modal path never wired up. Real confirmation goes through webview `confirmRequest`. Orphaned. |

---

## Files to Patch (8)

### 1. `src/sidebar/messageBridge.ts`
**What:** Two small additions to the shared type contract.
- Add `'clanker'` to `ForgeSlashCommandId` union
- Add `ClankerChangedMsg`:
  ```ts
  export interface ClankerChangedMsg { type: 'clankerChanged'; enabled: boolean }
  ```
- Add `ClankerChangedMsg` to the `HostToWebview` discriminated union

---

### 2. `src/sidebar/AgentLoop.ts`
**What:** The source of truth for clanker state + the bypass logic.
- Add `private clankerMode = false`
- Add `toggleClanker(): boolean` — flips flag, broadcasts `{ type: 'clankerChanged', enabled }` via `this.post`, returns new state
- In `requestToolApproval`: add early return at the top:
  ```ts
  if (this.clankerMode && !isDangerous) return true;
  ```
  `isDangerous` is already passed in — recursive deletes (`delete_file` + `recursive: true`) bypass nothing.
- On webview attach/restore: send current `clankerMode` state so pill renders correctly after panel hide/show

**Why instance-level (not module-level):** One `AgentLoop` instance serves all conversation tabs. Survives tab switches. Dies on VS Code exit. Correct scope.

---

### 3. `src/sidebar/SlashCommandHandler.ts`
**What:** Handle the new `/clanker` command.
- Add `toggleClanker: () => boolean` to `SlashCommandDeps` interface
- Add `case 'clanker':` to the switch:
  ```ts
  case 'clanker': {
    const on = deps.toggleClanker();
    deps.post({ type: 'token', text: on
      ? '\n> ⚙ **Full Clanker ON** — no confirmation until you run `/clanker` again. Recursive deletes still confirm.\n'
      : '\n> ⚙ **Full Clanker OFF** — confirmation restored.\n'
    });
    return;
  }
  ```

---

### 4. `src/sidebar/SidebarProvider.ts`
**What:** Wire `toggleClanker` into the deps object passed to `SlashCommandHandler`.
- Pass `toggleClanker: () => this.agentLoop.toggleClanker()` in the `SlashCommandDeps` object
- On webview ready/restore event: call `this.post({ type: 'clankerChanged', enabled: this.agentLoop.clankerMode })` so the pill state syncs on panel reopen

---

### 5. `webview-ui/src/slashCommands.ts`
**What:** Register the command in the slash menu.
```ts
{
  id: 'clanker',
  trigger: 'clanker',
  title: 'Full Clanker',
  description: 'Toggle full-auto mode — no confirmation prompts until you run /clanker again. Recursive deletes still confirm.',
}
```

---

### 6. `webview-ui/src/reducer.ts`
**What:** Track clanker state in the webview app state.
- Add `clankerMode: boolean` to state shape (default `false`)
- Handle `clankerChanged` message: `return { ...state, clankerMode: msg.enabled }`

---

### 7. `webview-ui/src/components/InputRow.tsx`
**What:** Render the warning pill.
- Add `clankerMode: boolean` to `Props`
- Inside `#input-btn-col`, left of Send/Stop:
  ```tsx
  {clankerMode && (
    <span id="clanker-pill" title="Full Clanker active — no confirmation prompts">
      ⚙ FULL CLANKER
    </span>
  )}
  ```
- Style: amber background, small caps, subtle pulse or static — visible but not alarming
- The pill disappears the moment the user runs `/clanker` again

---

### 8. `webview-ui/src/App.tsx`
**What:** Pass `clankerMode` from state down to `InputRow`.
- Read `state.clankerMode`
- Pass as `clankerMode={state.clankerMode}` prop to `<InputRow />`

---

## Pill Styling (to add to styles.css or InputRow inline)

```css
#clanker-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
  padding: 2px 7px;
  border-radius: 10px;
  background: #b8860b;       /* dark amber */
  color: #fff;
  opacity: 0.92;
  user-select: none;
  white-space: nowrap;
}
```

---

## Safety Invariants (never break these)

| Scenario | Behaviour |
|----------|-----------|
| `delete_file` + `recursive: true` | Always confirms, clanker ignored |
| All other write / terminal / git tools | Skip confirmation when clanker ON |
| Panel hidden then re-shown | Pill state restored via `clankerChanged` sync on webview ready |
| VS Code restart | `clankerMode` resets to `false` (instance field, not persisted) |
| User opens second conversation tab | Same `AgentLoop` instance — clanker state shared across all tabs |

---

## Sequence of Edits (recommended order to avoid compile errors)

1. `messageBridge.ts` — types first, everything else depends on them
2. `AgentLoop.ts` — logic + broadcast
3. `SlashCommandHandler.ts` — deps interface + case
4. `SidebarProvider.ts` — wiring
5. `slashCommands.ts` — webview command registry
6. `reducer.ts` — webview state
7. `App.tsx` — prop passthrough
8. `InputRow.tsx` — pill render + style
9. Delete `ConfirmationGate.ts`
10. `npx tsc --noEmit` + `npm run package`
