import { describe, expect, it } from 'vitest';
import { renderSmokeReport } from '../../src/benchmark/report';

describe('benchmark smoke report', () => {
  it('labels a one-task outcome without claiming a SWE score', () => {
    expect(renderSmokeReport([{ arm: 'qwen-forge', status: 'PASS', started_at: 'a', completed_at: 'b', workspace: 'w' }])).toContain('not a SWE-bench score');
  });
});
