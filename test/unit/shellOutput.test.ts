import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { capShellOutput, ShellOutputCollector, SHELL_OUTPUT_CAP, SHELL_OUTPUT_HEAD, SHELL_OUTPUT_TAIL, shellOutputRoot, sweepShellOutput } from '../../src/tools/shellOutput';

describe('shell output cap and spill', () => {
  it('keeps the exact head and tail and spills the complete output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-shell-output-'));
    try {
      const output = Array.from({ length: SHELL_OUTPUT_CAP + 100 }, (_, index) => String(index % 10)).join('');
      const capped = await capShellOutput(output, 'conversation', 'call', SHELL_OUTPUT_CAP, root);
      const marker = `\n[… 100 characters omitted. Full output: ${capped.spillPath} — search it with the shell (Select-String / rg / tail) instead of rerunning the command]\n`;
      expect(capped.text).toBe(`${output.slice(0, SHELL_OUTPUT_HEAD)}${marker}${output.slice(-SHELL_OUTPUT_TAIL)}`);
      expect(capped.spillPath).toBeDefined();
      expect(await fs.readFile(capped.spillPath!, 'utf8')).toBe(output);
      expect(capped.text).toContain(capped.spillPath);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('keeps raised-cap spills under shellOutputRoot and sweeps them by TTL', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-shell-home-'));
    const root = shellOutputRoot(home);
    try {
      const raisedCap = SHELL_OUTPUT_CAP + 100;
      const output = 'x'.repeat(raisedCap + 50);
      const capped = await capShellOutput(output, 'conv', 'call', raisedCap, root);
      expect(capped.spillPath).toBe(path.join(root, 'conv', 'call.log'));
      await expect(fs.readFile(capped.spillPath!, 'utf8')).resolves.toBe(output);
      const old = Date.now() - 25 * 60 * 60 * 1000;
      await fs.utimes(capped.spillPath!, new Date(old), new Date(old));
      await sweepShellOutput(root, Date.now());
      await expect(fs.access(capped.spillPath!)).rejects.toThrow();
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });

  it('sweeps a 25-hour-old spill but retains a 1-hour-old spill', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-shell-sweep-'));
    try {
      const old = path.join(root, 'conv', 'old.log');
      const fresh = path.join(root, 'conv', 'fresh.log');
      await fs.mkdir(path.dirname(old), { recursive: true });
      await fs.writeFile(old, 'old');
      await fs.writeFile(fresh, 'fresh');
      const now = Date.now();
      await fs.utimes(old, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));
      await fs.utimes(fresh, new Date(now - 60 * 60 * 1000), new Date(now - 60 * 60 * 1000));
      await sweepShellOutput(root, now);
      await expect(fs.access(old)).rejects.toThrow();
      await expect(fs.readFile(fresh, 'utf8')).resolves.toBe('fresh');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('streamed shell output (U17-01)', () => {
  it('holds only head and tail in memory past the cap, and spills everything', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-shell-stream-'));
    try {
      const collector = new ShellOutputCollector('conv', 'call', 300, root);
      const chunks = Array.from({ length: 5000 }, (_, index) => `line ${index}\n`);
      let peak = 0;
      for (const chunk of chunks) {
        collector.append(chunk);
        peak = Math.max(peak, String(Reflect.get(collector, 'head')).length + String(Reflect.get(collector, 'tail')).length);
      }
      await collector.drained();
      const full = chunks.join('');
      const streamed = await collector.finish();
      expect(peak).toBeLessThanOrEqual(100 + 2 * 200 + 'line 4999\n'.length);
      expect(await fs.readFile(streamed.spillPath!, 'utf8')).toBe(full);
      const whole = await capShellOutput(full, 'conv', 'whole', 300, root);
      expect(streamed.text).toBe(whole.text.replace(whole.spillPath!, streamed.spillPath!));
      expect(collector.append('late output after a kill')).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('output within the cap is returned whole and writes no spill file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-shell-stream-'));
    try {
      const collector = new ShellOutputCollector('conv', 'call', 300, root);
      collector.append('short\n');
      await expect(collector.finish()).resolves.toEqual({ text: 'short\n' });
      await expect(fs.readdir(root)).resolves.toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
