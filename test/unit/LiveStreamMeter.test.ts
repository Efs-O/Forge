import { describe, expect, it } from 'vitest';
import { LiveStreamMeter } from '../../src/sidebar/LiveStreamMeter';
import { liveStreamMetrics } from '../../src/sidebar/sidebarPayloads';

describe('LiveStreamMeter', () => {
  it('estimates thinking and answer separately, per conversation', () => {
    const meter = new LiveStreamMeter();
    meter.add('a', 'reasoning', 'x'.repeat(400));
    meter.add('a', 'answer', 'y'.repeat(40));
    meter.add('b', 'answer', 'z'.repeat(8));
    expect(meter.read('a')).toEqual({ reasoningTokens: 100, answerTokens: 10 });
    expect(meter.read('b')).toEqual({ reasoningTokens: 0, answerTokens: 2 });
  });

  it('forgets a request once the server reports its own count', () => {
    const meter = new LiveStreamMeter();
    meter.add('a', 'reasoning', 'thinking');
    meter.reset('a');
    expect(meter.read('a')).toBeUndefined();
    expect(liveStreamMetrics(meter.read('a'))).toEqual({});
  });
});
