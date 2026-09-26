import type { CodexAppServerSession } from '../agents/CodexAppServerSession';
import { getLogger } from '../util/logger';

const log = getLogger();

/** Dispose idle Codex app-servers while keeping their persisted thread ids. */
export class CodexIdleRelease {
  private readonly pending = new Map<string, Promise<void>>();

  release(alias: string, session: CodexAppServerSession): void {
    const task = session
      .dispose()
      .catch((err: unknown) => {
        log.error(`Could not release idle Codex thread for "${alias}".`, err);
      })
      .finally(() => {
        if (this.pending.get(alias) === task) this.pending.delete(alias);
      });
    this.pending.set(alias, task);
  }

  wait(alias: string): Promise<void> | undefined {
    return this.pending.get(alias);
  }

  all(): Iterable<Promise<void>> {
    return this.pending.values();
  }
}
