import type { BackendController } from './BackendController';
import type { BackendTurnLease } from './poolTypes';

/** Pins a model until its acquire is cancelled or the returned lease is released. */
export function acquireTurnLease(
  acquire: () => Promise<BackendController>,
  pin: () => void,
  unpin: () => void,
  signal?: AbortSignal,
): Promise<BackendTurnLease> {
  if (signal?.aborted) return Promise.reject(new Error('Backend turn acquisition cancelled.'));
  pin();
  let released = false;
  const releasePin = async (): Promise<void> => {
    if (released) return;
    released = true;
    unpin();
  };
  const acquisition = Promise.resolve()
    .then(acquire)
    .then(
      (backend) => ({ backend, release: releasePin }),
      (error: unknown) => {
        void releasePin();
        throw error;
      },
    );
  if (!signal) return acquisition;
  return new Promise<BackendTurnLease>((resolve, reject) => {
    const onAbort = (): void => {
      void releasePin();
      reject(new Error('Backend turn acquisition cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    acquisition.then(
      (lease) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          void lease.release();
          reject(new Error('Backend turn acquisition cancelled.'));
          return;
        }
        resolve(lease);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
