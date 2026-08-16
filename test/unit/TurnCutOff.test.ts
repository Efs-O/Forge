import { describe, expect, it } from 'vitest';
import { CONTEXT_EXHAUSTED_MESSAGE, isTurnCutOffError } from '../../src/agent/ToolCallingLoop';

describe('isTurnCutOffError', () => {
  it('recognises exhausted context', () => {
    expect(isTurnCutOffError(new Error(CONTEXT_EXHAUSTED_MESSAGE))).toBe(true);
  });

  it('recognises the tool-round cap', () => {
    expect(isTurnCutOffError(new Error('Forge: agent exceeded maximum tool rounds (40).'))).toBe(
      true,
    );
  });

  it('does not claim ordinary failures ran out of room', () => {
    // A resume after one of these would just re-run the same failing turn.
    expect(isTurnCutOffError(new Error('ECONNREFUSED 127.0.0.1:8080'))).toBe(false);
    expect(isTurnCutOffError(new Error('Forge: no active model selected.'))).toBe(false);
  });
});
