const THINK_OPEN_MARKERS = ['thought<|channel>', '<|channel>', '<|thinking|>', '<think>'] as const;

const THINK_CLOSE_MARKERS = ['<channel|>', '</|thinking|>', '</think>'] as const;

type Marker = (typeof THINK_OPEN_MARKERS)[number] | (typeof THINK_CLOSE_MARKERS)[number];

function findNextMarker(content: string, markers: readonly Marker[]): [number, Marker] | null {
  let best: [number, Marker] | null = null;
  for (const marker of markers) {
    const pos = content.indexOf(marker);
    if (pos === -1) continue;
    if (best === null || pos < best[0] || (pos === best[0] && marker.length < best[1].length)) {
      best = [pos, marker];
    }
  }
  return best;
}

function stripCarry(raw: string, carry: string): [string, string] {
  const content = `${carry}${raw}`;
  const allTags = [...THINK_OPEN_MARKERS, ...THINK_CLOSE_MARKERS];
  let bestCarry = '';
  for (const tag of allTags) {
    const maxPartial = Math.min(content.length, tag.length - 1);
    for (let i = 1; i <= maxPartial; i++) {
      const candidate = tag.slice(0, i);
      if (content.endsWith(candidate) && candidate.length > bestCarry.length) {
        bestCarry = candidate;
      }
    }
  }
  if (bestCarry) {
    return [
      content.slice(0, content.length - bestCarry.length),
      content.slice(content.length - bestCarry.length),
    ];
  }
  return [content, ''];
}

class ThinkRouter {
  private thinking = false;

  push(content: string): Array<[string, boolean]> {
    const result: Array<[string, boolean]> = [];
    let rest = content;
    while (true) {
      const markers = this.thinking ? THINK_CLOSE_MARKERS : THINK_OPEN_MARKERS;
      const found = findNextMarker(rest, markers);
      if (!found) {
        if (rest) result.push([rest, this.thinking]);
        return result;
      }
      const [pos, marker] = found;
      const before = rest.slice(0, pos);
      if (before) result.push([before, this.thinking]);
      this.thinking = !this.thinking;
      rest = rest.slice(pos + marker.length);
    }
  }
}

export class ThinkingChannelStripper {
  private carry = '';
  private readonly router = new ThinkRouter();

  push(raw: string): string {
    const [processed, nextCarry] = stripCarry(raw, this.carry);
    this.carry = nextCarry;
    const visible: string[] = [];
    for (const [segment, isThinking] of this.router.push(processed)) {
      if (!isThinking && segment) visible.push(segment);
    }
    return visible.join('');
  }
}

export function stripThinkingFromFullText(text: string): string {
  const router = new ThinkRouter();
  return router
    .push(text)
    .filter(([, isThinking]) => !isThinking)
    .map(([segment]) => segment)
    .join('');
}
