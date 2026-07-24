import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const LIVE_PROBE_FLAG = "FORGE_RUN_LIVE_CLI_PROBES";

export function requireLiveProbeOptIn() {
  if (process.env[LIVE_PROBE_FLAG] !== "1") {
    throw new Error(
      `Refusing to use subscription-backed CLIs. Set ${LIVE_PROBE_FLAG}=1 to run this probe.`,
    );
  }
}

export function requireCliPath(envName) {
  const value = process.env[envName]?.trim();
  if (!value) throw new Error(`Set ${envName} to the absolute CLI executable path.`);
  if (!path.isAbsolute(value)) throw new Error(`${envName} must be an absolute path.`);
  return value;
}

export async function makeProbeRepo(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const init = spawnSync("git", ["init", "--quiet"], {
    cwd: directory,
    windowsHide: true,
    encoding: "utf8",
  });
  if (init.status !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`git init failed: ${init.stderr || init.error?.message || "unknown error"}`);
  }
  return directory;
}

export async function removeProbeRepo(directory) {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 12,
    retryDelay: 250,
  });
}

export function spawnNdjsonProcess(executable, args, cwd) {
  const child = spawn(executable, args, {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  const listeners = new Set();
  const lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lineReader.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    for (const listener of listeners) listener(message);
  });

  return {
    child,
    stderr,
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(message) {
      if (!child.stdin.writable) throw new Error("CLI stdin is not writable.");
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    closeInput() {
      child.stdin.end();
    },
    async waitForExit(timeoutMs = 10_000) {
      if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CLI did not exit in time.")), timeoutMs);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    },
    async terminate() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await this.waitForExit();
    },
  };
}

export function waitForMessage(processHandle, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${label}.`));
    }, timeoutMs);
    const unsubscribe = processHandle.onMessage((message) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(message);
    });
  });
}

export function createJsonRpcClient(processHandle, timeoutMs = 120_000, includeVersion = false) {
  let nextId = 1;
  const pending = new Map();
  const notifications = new Set();

  processHandle.onMessage((message) => {
    if (message && Object.hasOwn(message, "id") && !message.method) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    if (message?.method) {
      for (const listener of notifications) listener(message);
    }
  });

  return {
    request(method, params) {
      const id = nextId++;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`JSON-RPC request timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
      });
      processHandle.send({
        ...(includeVersion ? { jsonrpc: "2.0" } : {}),
        method,
        id,
        params,
      });
      return promise;
    },
    notify(method, params) {
      processHandle.send({
        ...(includeVersion ? { jsonrpc: "2.0" } : {}),
        method,
        ...(params === undefined ? {} : { params }),
      });
    },
    onNotification(listener) {
      notifications.add(listener);
      return () => notifications.delete(listener);
    },
  };
}

export function waitForNotification(client, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${label}.`));
    }, timeoutMs);
    const unsubscribe = client.onNotification((message) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(message);
    });
  });
}
