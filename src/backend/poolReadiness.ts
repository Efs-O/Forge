import type { BackendProcess } from '../system/SystemReport';

/** Read-only status derived from the pool's owned, borrowed, and Ollama slots. */
interface ReadyBackend {
  isReady(): boolean;
}

export function anyBackendReady(
  owned: Iterable<{ backend: ReadyBackend }>,
  borrowed: Iterable<{ backend: ReadyBackend }>,
  ollama: Iterable<ReadyBackend>,
): boolean {
  for (const slot of owned) if (slot.backend.isReady()) return true;
  for (const slot of borrowed) if (slot.backend.isReady()) return true;
  for (const backend of ollama) if (backend.isReady()) return true;
  return false;
}

export function backendResidencySignature(
  keys: Iterable<string>,
  backendFor: (key: string) => ReadyBackend | undefined,
): string {
  return [...keys]
    .sort()
    .map((key) => `${key}:${backendFor(key)?.isReady() ? 'r' : 's'}`)
    .join(',');
}

/**
 * The loaded models this window can name a process for. Only owned slots
 * qualify: a borrowed shared runtime is another window's process — we know its
 * port, not its pid — and Ollama models live in the daemon, so neither can be
 * named here without inventing a number.
 */
export function ownedBackendProcesses(
  slots: ReadonlyMap<string, { backend: { serverPid(): number | null } }>,
): BackendProcess[] {
  const processes: BackendProcess[] = [];
  for (const [model, slot] of slots) {
    const pid = slot.backend.serverPid();
    if (pid !== null) processes.push({ model, pid });
  }
  return processes;
}
