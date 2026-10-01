import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

export const SdServerOwnerRecordSchema = z.object({
  pid: z.number().int().positive(),
  pidCreatedAt: z.number().positive(),
  port: z.number().int().min(1).max(65535),
  binary: z.string().min(1),
  diffusionModel: z.string().min(1),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  ownerPid: z.number().int().positive(),
  ownerCreatedAt: z.number().positive(),
  startedAt: z.number().positive(),
  lastUsedAt: z.number().positive(),
});

export type SdServerOwnerRecord = z.infer<typeof SdServerOwnerRecordSchema>;

export interface SdProcessIdentity {
  executablePath: string;
  createdAt: number;
}

const PROCESS_EXIT_TIMEOUT_MS = 10_000;
const PROCESS_EXIT_POLL_MS = 250;

const ProcessIdentitySchema = z.object({
  executablePath: z.string(),
  createdAt: z.number().positive(),
});

export function sdServerRecordPath(directory: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`sdcpp backend name "${name}" cannot be used as an owner-record filename.`);
  }
  return path.join(directory, `${name}.json`);
}

export async function readSdServerRecord(
  recordPath: string,
  warn: (message: string) => void,
): Promise<SdServerOwnerRecord | undefined> {
  let contents: string;
  try {
    contents = await fs.readFile(recordPath, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw new Error(
      `Could not read sd-server owner record "${recordPath}": ${errorMessage(error)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    warn(`Ignoring unreadable sd-server owner record "${recordPath}": ${errorMessage(error)}.`);
    return undefined;
  }
  const parsed = SdServerOwnerRecordSchema.safeParse(value);
  if (!parsed.success) {
    warn(
      `Ignoring invalid sd-server owner record "${recordPath}": ${parsed.error.message}. ` +
        'If the configured port is occupied, stop the unverified process manually.',
    );
    return undefined;
  }
  return parsed.data;
}

export async function writeSdServerRecord(
  recordPath: string,
  record: SdServerOwnerRecord,
): Promise<void> {
  const parsed = SdServerOwnerRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new Error(`Refusing to write invalid sd-server owner record: ${parsed.error.message}`);
  }
  const temporary = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(parsed.data)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.rename(temporary, recordPath);
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch (cleanupError) {
      if (!isErrno(cleanupError, 'ENOENT')) {
        throw new Error(
          `Could not write sd-server owner record "${recordPath}" (${errorMessage(error)}); ` +
            `temporary record cleanup also failed: ${errorMessage(cleanupError)}`,
        );
      }
    }
    throw new Error(
      `Could not atomically write sd-server owner record "${recordPath}": ${errorMessage(error)}`,
    );
  }
}

export async function deleteSdServerRecord(recordPath: string): Promise<void> {
  try {
    await fs.unlink(recordPath);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw new Error(
        `Could not delete sd-server owner record "${recordPath}": ${errorMessage(error)}`,
      );
    }
  }
}

/** Reads Windows process identity from CIM; there is intentionally no wmic fallback. */
export async function lookupWindowsProcess(pid: number): Promise<SdProcessIdentity | undefined> {
  if (process.platform !== 'win32') {
    throw new Error('sdcpp process identity requires Windows Get-CimInstance Win32_Process.');
  }
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
    'if ($null -eq $p) { "null" } else { ' +
    '[pscustomobject]@{ executablePath = $p.ExecutablePath; ' +
    'createdAt = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }';
  let output: string;
  try {
    ({ stdout: output } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5_000, windowsHide: true, encoding: 'utf8' },
    ));
  } catch (error) {
    throw new Error(
      `Could not inspect Windows process ${pid} with Get-CimInstance Win32_Process: ${errorMessage(error)}.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch (error) {
    throw new Error(
      `Get-CimInstance returned invalid process data for pid ${pid}: ${errorMessage(error)}.`,
    );
  }
  if (value === null) return undefined;
  const parsed = ProcessIdentitySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Get-CimInstance omitted the executable path or creation time for pid ${pid}.`);
  }
  return parsed.data;
}

export async function terminateWindowsProcessTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error(
      `Cannot safely terminate orphaned sd-server pid ${pid}: Windows taskkill is required.`,
    );
  }
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      timeout: 10_000,
      windowsHide: true,
      encoding: 'utf8',
    });
  } catch (error) {
    throw new Error(
      `Could not terminate verified orphaned sd-server pid ${pid}: ${errorMessage(error)}.`,
    );
  }
}

export function sameExecutablePath(left: string, right: string): boolean {
  return normalizeExecutablePath(left) === normalizeExecutablePath(right);
}

export function sameModelPath(left: string, right: string): boolean {
  return normalizeExecutablePath(left) === normalizeExecutablePath(right);
}

export function sameProcessCreation(
  identity: SdProcessIdentity | undefined,
  expected: number,
): boolean {
  return identity !== undefined && identity.createdAt === expected;
}

export async function waitForSdProcessExit(
  lookupProcess: (pid: number) => Promise<SdProcessIdentity | undefined>,
  pid: number,
  createdAt: number,
  now: () => number,
): Promise<void> {
  const deadline = now() + PROCESS_EXIT_TIMEOUT_MS;
  while (now() < deadline) {
    if (!sameProcessCreation(await lookupProcess(pid), createdAt)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
  }
  throw new Error(`Verified orphaned sd-server pid ${pid} did not exit after taskkill.`);
}

function normalizeExecutablePath(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
