import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { writeFileAtomic } from '../util/atomicWrite';

export const RELOAD_RESERVATION_MS = 120_000;

const ReloadReservationSchema = z.object({
  version: z.literal(1),
  key: z.string().min(1),
  workspaceId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});

type ReloadReservation = z.infer<typeof ReloadReservationSchema>;

function reservationPath(directory: string, key: string): string {
  return path.join(directory, `${key}.reload-reservation.json`);
}

async function readReservation(filePath: string): Promise<ReloadReservation | undefined> {
  try {
    return ReloadReservationSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch {
    return undefined;
  }
}

export async function writeReloadReservation(
  directory: string,
  key: string,
  workspaceId: string,
  now = Date.now(),
): Promise<void> {
  const reservation: ReloadReservation = {
    version: 1,
    key,
    workspaceId,
    createdAt: now,
    expiresAt: now + RELOAD_RESERVATION_MS,
  };
  await fs.mkdir(directory, { recursive: true });
  await writeFileAtomic(
    reservationPath(directory, key),
    `${JSON.stringify(reservation, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function reservedForAnotherWorkspace(
  directory: string,
  key: string,
  workspaceId: string,
  now = Date.now(),
): Promise<{ expiresAt: number } | undefined> {
  const reservation = await readReservation(reservationPath(directory, key));
  if (
    !reservation ||
    reservation.key !== key ||
    reservation.workspaceId === workspaceId ||
    reservation.expiresAt <= now
  ) {
    return undefined;
  }
  return { expiresAt: reservation.expiresAt };
}

export async function clearOwnReloadReservation(
  directory: string,
  key: string,
  workspaceId: string,
): Promise<void> {
  const filePath = reservationPath(directory, key);
  const reservation = await readReservation(filePath);
  if (reservation?.key === key && reservation.workspaceId === workspaceId) {
    await fs.unlink(filePath);
  }
}

export function isReloadCancellation(error: unknown): boolean {
  if (error instanceof Error) return error.name === 'Canceled' || error.message === 'Canceled';
  return String(error) === 'Canceled';
}

export interface ReloadForTelegramDeps {
  telegramChatId?: string;
  setReloadNotice: (chatId: string, expiresAt: number) => Promise<void>;
  clearReloadNotice: () => Promise<void>;
  writeReservation: () => Promise<void>;
  clearReservation: () => Promise<void>;
  executeWindowReloadCommand: () => Promise<void>;
  log: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  showErrorMessage: (message: string) => void;
  now?: () => number;
}

const RELOAD_NOTICE_TTL_MS = 5 * 60_000;

export async function reloadForTelegram(deps: ReloadForTelegramDeps): Promise<void> {
  const chatId = deps.telegramChatId;
  try {
    if (chatId) {
      await deps.setReloadNotice(chatId, (deps.now ?? Date.now)() + RELOAD_NOTICE_TTL_MS);
      try {
        await deps.writeReservation();
      } catch (error) {
        deps.log.warn(
          `[remote] could not reserve Telegram for the reload, so another open Forge window may take it until this one is back: ${String(error)}`,
        );
      }
    }
    await deps.executeWindowReloadCommand();
  } catch (error) {
    if (isReloadCancellation(error)) {
      deps.log.info(
        '[remote] window reload is under way (the reload command answers "Canceled" when the window shuts down)',
      );
      return;
    }
    if (chatId) {
      await deps.clearReloadNotice().catch((clearError: unknown) => {
        deps.log.warn(`[remote] could not clear Telegram reload notice: ${String(clearError)}`);
      });
      await deps.clearReservation().catch((clearError: unknown) => {
        deps.log.warn(
          `[remote] could not clear the Telegram reload reservation: ${String(clearError)}`,
        );
      });
    }
    deps.log.error(`[remote] window reload failed: ${String(error)}`);
    deps.showErrorMessage(`Forge window reload failed: ${String(error)}`);
  }
}
