import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SERVER_LOG_MAX_READ_BYTES,
  ServerLogFollower,
  ServerLogFollowers,
  type LogSink,
} from '../../src/backend/serverLogFollower';
import type { ForgeConfig } from '../../src/config/types';

class Sink implements LogSink {
  lines: string[] = [];
  disposed = false;
  appendLine(line: string): void {
    this.lines.push(line);
  }
  dispose(): void {
    this.disposed = true;
  }
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-serverlog-'));
  file = path.join(dir, 'server.log');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ServerLogFollower', () => {
  it('starts at the end of an existing file and shows only new lines', async () => {
    await fs.writeFile(file, 'old line 1\r\nold line 2\r\n');
    const sink = new Sink();
    const follower = new ServerLogFollower(file, sink);
    await follower.poll();
    await fs.appendFile(file, 'strata serve: 400 generated in 6893 ms (58.0 tok/s)\r\n');
    await follower.poll();
    expect(sink.lines).toEqual(['strata serve: 400 generated in 6893 ms (58.0 tok/s)']);
  });

  it('holds back an unfinished line until its newline arrives', async () => {
    await fs.writeFile(file, '');
    const sink = new Sink();
    const follower = new ServerLogFollower(file, sink);
    await follower.poll();
    await fs.appendFile(file, 'half a ');
    await follower.poll();
    expect(sink.lines).toEqual([]);
    await fs.appendFile(file, 'line\n');
    await follower.poll();
    expect(sink.lines).toEqual(['half a line']);
  });

  it('keeps only the final state of a carriage-return progress bar', async () => {
    await fs.writeFile(file, '');
    const sink = new Sink();
    const follower = new ServerLogFollower(file, sink);
    await follower.poll();
    await fs.appendFile(file, 'load 10%\rload 50%\rload 100%\r\n');
    await follower.poll();
    expect(sink.lines).toEqual(['load 100%']);
  });

  it('reads a truncated (restarted) log from the start and says so', async () => {
    await fs.writeFile(file, 'a long first run of the server log\n');
    const sink = new Sink();
    const follower = new ServerLogFollower(file, sink);
    await follower.poll();
    await fs.writeFile(file, 'new run\n');
    await follower.poll();
    expect(sink.lines[0]).toMatch(/truncated/);
    expect(sink.lines[1]).toBe('new run');
  });

  it('reports a missing file once, then follows it from the start when created', async () => {
    const sink = new Sink();
    const follower = new ServerLogFollower(file, sink);
    await follower.poll();
    await follower.poll();
    expect(sink.lines).toEqual([`[Forge] waiting for ${file} (not created yet)`]);
    // A file born after Forge started is all new output: shown from its first line.
    await fs.writeFile(file, 'first line\n');
    await follower.poll();
    await fs.appendFile(file, 'second line\n');
    await follower.poll();
    expect(sink.lines.slice(1)).toEqual(['first line', 'second line']);
  });

  it('caps one read and reports the skipped backlog', async () => {
    await fs.writeFile(file, '');
    const sink = new Sink();
    const follower = new ServerLogFollower(file, sink);
    await follower.poll();
    await fs.appendFile(file, 'x'.repeat(SERVER_LOG_MAX_READ_BYTES + 10) + '\nlast\n');
    await follower.poll();
    expect(sink.lines[0]).toMatch(/skipped \d+ bytes of backlog/);
    expect(sink.lines.at(-1)).toBe('last');
  });
});

describe('ServerLogFollowers', () => {
  const configWith = (logs: Array<string | undefined>): ForgeConfig =>
    ({
      models: logs.map((server_log, i) => ({ name: `m${i}`, display_name: `Model ${i}`, server_log })),
    }) as unknown as ForgeConfig;

  it('follows each distinct path once, keeps followers across reloads, drops removed ones', () => {
    const sinks = new Map<string, Sink>();
    const followers = new ServerLogFollowers((name) => {
      const sink = new Sink();
      sinks.set(name, sink);
      return sink;
    });
    try {
      followers.apply(configWith([file, file, undefined]));
      expect(followers.paths).toEqual([file]);
      expect([...sinks.keys()]).toEqual(['Forge - Model 0 log']);

      followers.apply(configWith([file]));
      expect(sinks.size).toBe(1);

      followers.apply(configWith([undefined]));
      expect(followers.paths).toEqual([]);
      expect(sinks.get('Forge - Model 0 log')?.disposed).toBe(true);
    } finally {
      followers.dispose();
    }
  });
});
