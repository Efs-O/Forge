import * as net from 'net';
import type { UpsStats } from './monitorTypes';

const MAX_LINE = 4096;
const MAX_REPLY = 65536;
const TIMEOUT_MS = 1000;
const KEYS = new Set([
  'ups.status',
  'ups.load',
  'battery.charge',
  'battery.runtime',
  'input.voltage',
  'output.voltage',
]);

export function splitNutSpec(spec: string): { name: string; host: string; port: number } {
  const match = /^([^@\s]+)@(?:\[([^\]]+)\]|([^:\s]+))(?::(\d+))?$/.exec(spec);
  if (!match) throw new Error(`Invalid NUT UPS spec: ${spec}`);
  const port = match[4] ? Number(match[4]) : 3493;
  if (port < 1 || port > 65535) throw new Error(`Invalid NUT port: ${match[4]}`);
  return { name: match[1], host: match[2] ?? match[3], port };
}

export async function readNutStats(spec: string, signal?: AbortSignal): Promise<UpsStats> {
  const { name, host, port } = splitNutSpec(spec);
  return new Promise<UpsStats>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let total = 0;
    let began = false;
    let finished = false;
    const values: Record<string, string> = {};
    const timer = setTimeout(
      () => fail(new Error(`NUT server at ${host}:${port} timed out after ${TIMEOUT_MS} ms`)),
      TIMEOUT_MS,
    );
    const onAbort = (): void => fail(new Error('NUT request aborted'));
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error): void => {
      if (finished) return;
      finished = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    socket.on('connect', () => socket.write(`LIST VAR ${name}\n`));
    socket.on('error', (error) => fail(error));
    socket.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REPLY) return fail(new Error(`NUT reply exceeded ${MAX_REPLY} bytes`));
      buffer = Buffer.concat([buffer, chunk]);
      let newline: number;
      while ((newline = buffer.indexOf(10)) >= 0) {
        if (newline > MAX_LINE) return fail(new Error(`NUT line exceeded ${MAX_LINE} bytes`));
        const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
        buffer = buffer.subarray(newline + 1);
        if (!began) {
          const expected = `BEGIN LIST VAR ${name}`;
          if (line !== expected)
            return fail(new Error(`NUT server at ${host}:${port} said: ${line}`));
          began = true;
          continue;
        }
        if (line === `END LIST VAR ${name}` || line === 'END LIST VAR') {
          if (!Object.hasOwn(values, 'ups.status'))
            return fail(new Error('NUT reply had no ups.status'));
          finished = true;
          cleanup();
          socket.write('LOGOUT\n', () => socket.end());
          resolve({ values });
          return;
        }
        const match = /^VAR\s+\S+\s+(\S+)\s+"((?:[^"\\]|\\.)*)"$/.exec(line);
        if (match && KEYS.has(match[1]))
          values[match[1]] = match[2].replace(/\\x([0-9a-fA-F]{2})/g, (_all, hex: string) =>
            String.fromCharCode(parseInt(hex, 16)),
          );
      }
      if (buffer.length > MAX_LINE) fail(new Error(`NUT line exceeded ${MAX_LINE} bytes`));
    });
  });
}
