import type { TurnLifecycle } from './TurnLifecycle';
import type { IBackendPool } from '../backend/poolTypes';
import type { HostToWebview } from './messageBridge';

const RESUME_RETRY_MS = 250;
const RESUME_NOTICE_MS = 500;

export function isLocalCapacityRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('no free slot and no eviction candidate');
}

export function isExternalCapacityRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /would cut that turn off|needs the GPUs .* is using for chat/i.test(message);
}

export function resumeWaitMessages(
  conversationId: string,
  modelName: string,
  post: (msg: HostToWebview) => void,
): { waiting: () => void; ready: () => void } {
  return {
    waiting: () =>
      post({
        type: 'backendStarting',
        conversationId,
        message: `Waiting to resume on ${modelName}; your answer is saved.`,
      }),
    ready: () => post({ type: 'ready', conversationId }),
  };
}

export function acquireExternalHold(
  pool: IBackendPool,
  modelName: string,
  conversationId: string,
  title: string,
  signal: AbortSignal,
): Promise<{ release(): void } | undefined> {
  const pending = pool.acquireExternalTurnHold?.(modelName, conversationId, title);
  if (!pending) return Promise.resolve(undefined);
  if (signal.aborted) {
    void pending.then(
      (lease) => lease.release(),
      () => undefined,
    );
    return Promise.reject(new Error('External model hold acquisition cancelled.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      settled = true;
      reject(new Error('External model hold acquisition cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (lease) => {
        signal.removeEventListener('abort', onAbort);
        if (settled || signal.aborted) {
          lease.release();
          return;
        }
        settled = true;
        resolve(lease);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

/** Release provider capacity only around an attended question's remaining wait. */
export async function withSuspendedQuestionWait<T>(
  lifecycle: TurnLifecycle,
  conversationId: string,
  signal: AbortSignal,
  wait: () => Promise<T>,
  release: () => Promise<void>,
  reacquire: () => Promise<void>,
): Promise<T> {
  await release();
  lifecycle.clearBackend(conversationId);
  lifecycle.suspendModelDemand(conversationId);

  let value: T | undefined;
  let waitError: unknown;
  let waitFailed = false;
  try {
    value = await wait();
  } catch (error) {
    waitFailed = true;
    waitError = error;
  }

  if (!signal.aborted) {
    await reacquire();
    if (!signal.aborted) lifecycle.resumeModelDemand(conversationId);
  }
  if (waitFailed) throw waitError;
  return value as T;
}

/** Retry only a recognized capacity refusal; cancellation ends the wait promptly. */
export async function retryResumeAcquire<T>(
  signal: AbortSignal,
  acquire: () => Promise<T>,
  isCapacityRefusal: (error: unknown) => boolean,
  onWaiting: () => void,
  onReady: () => void,
  releaseAcquired?: (value: T) => void | Promise<void>,
): Promise<T> {
  let announced = false;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      if (signal.aborted) throw new Error('Model reacquisition cancelled.');
      try {
        const value = await acquire();
        if (signal.aborted) {
          await releaseAcquired?.(value);
          throw new Error('Model reacquisition cancelled.');
        }
        if (announced) onReady();
        return value;
      } catch (error) {
        if (signal.aborted || !isCapacityRefusal(error)) throw error;
        if (!noticeTimer) {
          noticeTimer = setTimeout(() => {
            announced = true;
            onWaiting();
          }, RESUME_NOTICE_MS);
        }
        await abortableDelay(RESUME_RETRY_MS, signal);
      }
    }
  } finally {
    if (noticeTimer) clearTimeout(noticeTimer);
  }
}

/** Abort a bounded poll without leaving its timer or listener behind. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Model reacquisition cancelled.'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Model reacquisition cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
