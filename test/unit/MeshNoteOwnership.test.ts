/**
 * Phase B CI check 3 (`docs/plans/AGENT_DOCS_GAP_AUDIT_PLAN.md` § "Phase B
 * scope", Claude's review of the phase A report): the store page must not tell
 * a reader that Forge leaves their instruction files alone.
 *
 * Phase A row C2: `README.md` said "Nothing needs to go into Claude's memory or
 * a user's `AGENTS.md` … Forge never edits either file" and called the agent
 * note an optional paragraph a user may add. It is not optional and Forge does
 * edit those files: `src/agentBus/agentMeshNote.ts:189-246` (`applyAgentMeshNote`,
 * `agentNoteTargetFiles`) and `src/vscode/agentMeshNoteSetup.ts:99-137`
 * (`installIntoOneFile`, `installAgentMeshNote`) write a marked section into
 * every `AGENTS.md` and `CLAUDE.md` a workspace has, creating `AGENTS.md` when
 * neither exists. A user who believed the store page thought the section was
 * theirs to keep up to date, and Forge's write came as a surprise.
 *
 * This is a pin, not a general doc checker: `DocClaimsDrift.test.ts` already
 * compares README's slash table, its tool names and its `forge.*` keys against
 * code. The point here is that the ownership claim cannot quietly flip back.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { AGENT_NOTE_END, AGENT_NOTE_START } from '../../src/agentBus/agentMeshNote';

const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');

describe('the store page tells the truth about the agent note', () => {
  it('names the marked section Forge writes', () => {
    expect(readme).toContain(AGENT_NOTE_START);
    expect(readme).toContain(AGENT_NOTE_END);
    expect(readme).toMatch(/writes its own agent-bus note into a marked section/);
    // The refresh is part of the same sentence: a reader who is told Forge
    // writes the section must also learn it is refreshed, not hand-maintained.
    expect(readme).toMatch(/refreshes that section/);
  });

  it('points at the command that re-runs the install', () => {
    expect(readme).toContain('Set Up Agent Note');
  });

  it('does not claim Forge never edits AGENTS.md or CLAUDE.md', () => {
    expect(readme).not.toMatch(/Forge never edits (either file|`?AGENTS\.md`?|`?CLAUDE\.md`?)/);
    // The section is not "optional": the mesh writes it whenever `agent_bus`
    // is on, so the word "optional" must not sit next to the note either.
    expect(readme).not.toMatch(/add this optional note/);
  });
});
