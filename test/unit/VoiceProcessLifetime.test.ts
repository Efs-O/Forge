import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A child that never exits on its own: only kill() closes it. */
class HangingChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly stdin = Object.assign(new EventEmitter(), { end: () => undefined });
  killed = false;
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit('close', null));
    return true;
  }
}

const children: HangingChild[] = [];
vi.mock('child_process', () => ({
  spawn: () => {
    const child = new HangingChild();
    children.push(child);
    return child;
  },
}));
vi.mock('../../src/tools/ffmpegLocate', () => ({
  resolveFfmpeg: () => ({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
}));

import { encodeToOpus, normalizeToWav } from '../../src/voice/AudioNormalizer';
import { PiperRunner } from '../../src/voice/PiperRunner';
import { VoiceOperation } from '../../src/voice/VoiceOperation';
import { buildVoiceBridge } from '../../src/remote/remoteVoiceWiring';
import { RemoteSpeechDelivery } from '../../src/remote/RemoteSpeechDelivery';
import type { RemoteVoiceBridgeOptions } from '../../src/remote/RemoteVoiceBridge';
import type { RemoteChannel } from '../../src/remote/types';
import type { ForgeConfig } from '../../src/config/types';

let operation: VoiceOperation;
let voicesDir: string;

beforeEach(async () => {
  children.length = 0;
  operation = await VoiceOperation.create();
  voicesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-voices-'));
  await fs.writeFile(path.join(voicesDir, 'v.onnx'), '');
});

afterEach(async () => {
  await operation.dispose();
  await fs.rm(voicesDir, { recursive: true, force: true });
});

describe('voice child processes end with the transport (U09-01, U10-02, U19-03)', () => {
  it('ffmpeg is killed at its deadline instead of hanging the turn', async () => {
    const done = encodeToOpus(operation, 'in.wav', { timeoutMs: 20 });
    await expect(done).rejects.toThrow('ffmpeg timed out after 20 ms');
    expect(children[0]?.killed).toBe(true);
  });

  it('ffmpeg is killed when the signal aborts, and an aborted signal spawns nothing', async () => {
    const controller = new AbortController();
    const source = { path: 'in.ogg', mediaType: 'audio/ogg' } as Parameters<
      typeof normalizeToWav
    >[1];
    const done = normalizeToWav(operation, source, { signal: controller.signal });
    controller.abort();
    await expect(done).rejects.toThrow('audio normalization cancelled');
    expect(children[0]?.killed).toBe(true);

    await expect(normalizeToWav(operation, source, { signal: controller.signal })).rejects.toThrow(
      'cancelled',
    );
    expect(children).toHaveLength(1);
  });

  it('Piper is killed when the signal aborts, not left to run out its timeout', async () => {
    const controller = new AbortController();
    const piper = new PiperRunner({ binary: 'piper', voicesDir, timeoutMs: 60_000 });
    const done = piper.synthesize(operation, 'hello', 'v', controller.signal);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    controller.abort();
    await expect(done).rejects.toThrow('piper cancelled');
    expect(children[0]?.killed).toBe(true);
  });

  it('a stopped transport is not reported as failing spoken replies', async () => {
    const controller = new AbortController();
    const piper = new PiperRunner({ binary: 'piper', voicesDir, timeoutMs: 60_000 });
    const sent: string[] = [];
    const errors: string[] = [];
    const channel = {
      name: 'telegram',
      send: async (_chatId: string, text: string) => void sent.push(text),
      sendVoice: async () => undefined,
    } as unknown as RemoteChannel;
    const delivery = new RemoteSpeechDelivery(
      channel,
      piper,
      () => ({ enabled: true, voiceEn: 'v', voiceEl: 'v', maxChars: 600 }),
      controller.signal,
      (message) => errors.push(message),
    );
    const spoken = delivery.speak('42', 'The backend is running and every test passed.');
    await vi.waitFor(() => expect(children).toHaveLength(1));
    controller.abort();
    await expect(spoken).resolves.toBe(false);
    expect(children[0]?.killed).toBe(true);
    expect(errors).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('the voice bridge receives the transport signal', () => {
    const controller = new AbortController();
    let options: RemoteVoiceBridgeOptions | undefined;
    const config = {
      voice: { enabled: true, whisper_model: 'm.bin', whisper_binary: 'whisper-cli' },
    } as unknown as ForgeConfig;
    buildVoiceBridge(
      { name: 'telegram' } as unknown as RemoteChannel,
      config,
      { append: async () => undefined } as never,
      { signal: controller.signal },
      (built) => {
        options = built;
        return {} as never;
      },
    );
    expect(options?.signal).toBe(controller.signal);
  });
});
