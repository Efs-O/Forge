import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearOwnReloadReservation,
  isReloadCancellation,
  RELOAD_RESERVATION_MS,
  reloadForTelegram,
  reservedForAnotherWorkspace,
  writeReloadReservation,
} from '../../src/remote/remoteReloadReservation';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-reload-reservation-'));
  directories.push(directory);
  return directory;
}

describe('Telegram reload reservation', () => {
  it('writes a validated reservation with the configured TTL', async () => {
    const directory = await tempDirectory();
    await writeReloadReservation(directory, 'telegram', 'workspace-x', 1_000);

    await expect(
      reservedForAnotherWorkspace(directory, 'telegram', 'workspace-y', 1_001),
    ).resolves.toEqual({ expiresAt: 1_000 + RELOAD_RESERVATION_MS });
    await expect(
      reservedForAnotherWorkspace(directory, 'telegram', 'workspace-x', 1_001),
    ).resolves.toBeUndefined();
    await expect(
      reservedForAnotherWorkspace(
        directory,
        'telegram',
        'workspace-y',
        1_000 + RELOAD_RESERVATION_MS,
      ),
    ).resolves.toBeUndefined();
  });

  it('does not block on missing, unreadable, unparseable or wrong-schema files', async () => {
    const directory = await tempDirectory();
    await expect(
      reservedForAnotherWorkspace(directory, 'telegram', 'workspace-y', 10),
    ).resolves.toBeUndefined();

    const file = path.join(directory, 'telegram.reload-reservation.json');
    await fs.writeFile(file, '{');
    await expect(
      reservedForAnotherWorkspace(directory, 'telegram', 'workspace-y', 10),
    ).resolves.toBeUndefined();
    await fs.writeFile(file, JSON.stringify({ version: 2, key: 'telegram' }));
    await expect(
      reservedForAnotherWorkspace(directory, 'telegram', 'workspace-y', 10),
    ).resolves.toBeUndefined();

    await fs.rm(file);
    await fs.mkdir(file);
    await expect(
      reservedForAnotherWorkspace(directory, 'telegram', 'workspace-y', 10),
    ).resolves.toBeUndefined();
  });

  it('clears only a reservation owned by the supplied workspace', async () => {
    const directory = await tempDirectory();
    await writeReloadReservation(directory, 'telegram', 'workspace-x', 100);
    await clearOwnReloadReservation(directory, 'telegram', 'workspace-y');
    await expect(
      reservedForAnotherWorkspace(directory, 'telegram', 'workspace-y', 101),
    ).resolves.toEqual({ expiresAt: 100 + RELOAD_RESERVATION_MS });

    await clearOwnReloadReservation(directory, 'telegram', 'workspace-x');
    await expect(
      reservedForAnotherWorkspace(directory, 'telegram', 'workspace-y', 101),
    ).resolves.toBeUndefined();
  });
});

interface ReloadHarness {
  notice: { chatId: string; expiresAt: number } | undefined;
  reservation: boolean;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
  writeReservation: ReturnType<typeof vi.fn>;
  executeWindowReloadCommand: ReturnType<typeof vi.fn>;
}

function reloadHarness(): ReloadHarness {
  const state: ReloadHarness = {
    notice: undefined,
    reservation: false,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    showErrorMessage: vi.fn(),
    writeReservation: vi.fn(async () => {
      state.reservation = true;
    }),
    executeWindowReloadCommand: vi.fn(),
  };
  return state;
}

describe('reloadForTelegram', () => {
  it.each([
    ['Canceled message', new Error('Canceled')],
    ['Canceled name', Object.assign(new Error('window shutdown'), { name: 'Canceled' })],
    ['Canceled string', 'Canceled'],
  ])('keeps the notice and reservation when reload rejects with %s', async (_label, rejection) => {
    const state = reloadHarness();
    state.executeWindowReloadCommand.mockRejectedValue(rejection);
    await reloadForTelegram({
      telegramChatId: 'chat-1',
      setReloadNotice: async (chatId, expiresAt) => {
        state.notice = { chatId, expiresAt };
      },
      clearReloadNotice: async () => {
        state.notice = undefined;
      },
      writeReservation: state.writeReservation,
      clearReservation: async () => {
        state.reservation = false;
      },
      executeWindowReloadCommand: state.executeWindowReloadCommand,
      log: { info: state.info, warn: state.warn, error: state.error },
      showErrorMessage: state.showErrorMessage,
      now: () => 50,
    });

    expect(state.notice).toEqual({ chatId: 'chat-1', expiresAt: 50 + 5 * 60_000 });
    expect(state.reservation).toBe(true);
    expect(state.info.mock.calls[0][0]).toBe(
      '[remote] window reload is under way (the reload command answers "Canceled" when the window shuts down)',
    );
    expect(state.warn).not.toHaveBeenCalled();
    expect(state.error).not.toHaveBeenCalled();
    expect(state.showErrorMessage).not.toHaveBeenCalled();
    expect(isReloadCancellation(rejection)).toBe(true);
  });

  it('clears state and reports a real reload failure', async () => {
    const state = reloadHarness();
    state.executeWindowReloadCommand.mockRejectedValue(new Error('boom'));
    await reloadForTelegram({
      telegramChatId: 'chat-1',
      setReloadNotice: async (chatId, expiresAt) => {
        state.notice = { chatId, expiresAt };
      },
      clearReloadNotice: async () => {
        state.notice = undefined;
      },
      writeReservation: state.writeReservation,
      clearReservation: async () => {
        state.reservation = false;
      },
      executeWindowReloadCommand: state.executeWindowReloadCommand,
      log: { info: state.info, warn: state.warn, error: state.error },
      showErrorMessage: state.showErrorMessage,
    });

    expect(state.notice).toBeUndefined();
    expect(state.reservation).toBe(false);
    expect(state.error.mock.calls[0][0]).toBe('[remote] window reload failed: Error: boom');
    expect(state.showErrorMessage.mock.calls[0][0]).toBe('Forge window reload failed: Error: boom');
    expect(isReloadCancellation(new Error('boom'))).toBe(false);
  });

  it('logs the exact warning when clearing the reservation fails', async () => {
    const state = reloadHarness();
    state.executeWindowReloadCommand.mockRejectedValue(new Error('boom'));
    await reloadForTelegram({
      telegramChatId: 'chat-1',
      setReloadNotice: async () => undefined,
      clearReloadNotice: async () => undefined,
      writeReservation: async () => undefined,
      clearReservation: async () => {
        throw new Error('sharing violation');
      },
      executeWindowReloadCommand: state.executeWindowReloadCommand,
      log: { info: state.info, warn: state.warn, error: state.error },
      showErrorMessage: state.showErrorMessage,
    });

    expect(state.warn.mock.calls[0][0]).toBe(
      '[remote] could not clear the Telegram reload reservation: Error: sharing violation',
    );
  });

  it('retains the existing exact warning when clearing the notice fails', async () => {
    const state = reloadHarness();
    state.executeWindowReloadCommand.mockRejectedValue(new Error('boom'));
    await reloadForTelegram({
      telegramChatId: 'chat-1',
      setReloadNotice: async () => undefined,
      clearReloadNotice: async () => {
        throw new Error('memento unavailable');
      },
      writeReservation: async () => undefined,
      clearReservation: async () => undefined,
      executeWindowReloadCommand: state.executeWindowReloadCommand,
      log: { info: state.info, warn: state.warn, error: state.error },
      showErrorMessage: state.showErrorMessage,
    });

    expect(state.warn.mock.calls[0][0]).toBe(
      '[remote] could not clear Telegram reload notice: Error: memento unavailable',
    );
  });

  it('logs a failed reservation write and still reloads', async () => {
    const state = reloadHarness();
    state.writeReservation.mockRejectedValue(new Error('disk full'));
    await reloadForTelegram({
      telegramChatId: 'chat-1',
      setReloadNotice: async () => undefined,
      clearReloadNotice: async () => undefined,
      writeReservation: state.writeReservation,
      clearReservation: async () => undefined,
      executeWindowReloadCommand: state.executeWindowReloadCommand,
      log: { info: state.info, warn: state.warn, error: state.error },
      showErrorMessage: state.showErrorMessage,
    });

    expect(state.warn.mock.calls[0][0]).toBe(
      '[remote] could not reserve Telegram for the reload, so another open Forge window may take it until this one is back: Error: disk full',
    );
    expect(state.executeWindowReloadCommand).toHaveBeenCalledTimes(1);
    expect(state.error).not.toHaveBeenCalled();
  });

  it('does not write a notice or reservation when there is no chat id', async () => {
    const state = reloadHarness();
    await reloadForTelegram({
      setReloadNotice: async () => {
        throw new Error('notice should not be written');
      },
      clearReloadNotice: async () => undefined,
      writeReservation: state.writeReservation,
      clearReservation: async () => undefined,
      executeWindowReloadCommand: state.executeWindowReloadCommand,
      log: { info: state.info, warn: state.warn, error: state.error },
      showErrorMessage: state.showErrorMessage,
    });

    expect(state.writeReservation).not.toHaveBeenCalled();
    expect(state.executeWindowReloadCommand).toHaveBeenCalledTimes(1);
    expect(state.notice).toBeUndefined();
  });
});
