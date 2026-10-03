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
