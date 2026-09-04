import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceTranscriptionError } from '../../src/voice/VoiceTypes';
import { WhisperServerRunner } from '../../src/voice/WhisperServerRunner';

const tempDirs: string[] = [];

function wavFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-whisper-http-'));
  tempDirs.push(dir);
  const wav = path.join(dir, 'voice.wav');
  fs.writeFileSync(wav, Buffer.from('RIFF-test-wave'));
  return wav;
}

describe('WhisperServerRunner', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('posts the WAV as multipart and requests a plain-text transcript', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response('γειά σου');
    }) as unknown as typeof fetch;
    const runner = new WhisperServerRunner({
      baseUrl: 'http://127.0.0.1:8092',
      model: 'large-v3.bin',
      fetchFn,
    });

    const transcript = await runner.transcribe(wavFixture(), {
      language: 'el',
      initialPrompt: 'Forge, CUDA',
    });

    expect(requestUrl).toBe('http://127.0.0.1:8092/inference');
    expect(requestInit?.method).toBe('POST');
    const form = requestInit?.body as FormData;
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(form.get('response_format')).toBe('text');
    expect(form.get('language')).toBe('el');
    expect(form.get('prompt')).toBe('Forge, CUDA');
    expect(transcript).toMatchObject({
      text: 'γειά σου',
      backend: 'whisper.cpp server',
      model: 'large-v3.bin',
      device: 'gpu',
      biasPromptUsed: true,
    });
  });

  it('sends auto language because whisper-server otherwise defaults to English', async () => {
    let form: FormData | undefined;
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      form = init?.body as FormData;
      return new Response('hello');
    }) as unknown as typeof fetch;
    const runner = new WhisperServerRunner({ baseUrl: 'http://local', model: 'm', fetchFn });
    await runner.transcribe(wavFixture(), { language: 'auto' });
    expect(form?.get('language')).toBe('auto');
    expect(form?.has('prompt')).toBe(false);
  });

  it('maps HTTP failures to the closed stt_failed reason', async () => {
    const fetchFn = vi.fn(async () => new Response('model failed', { status: 500 })) as unknown as typeof fetch;
    const runner = new WhisperServerRunner({ baseUrl: 'http://local', model: 'm', fetchFn });
    await expect(runner.transcribe(wavFixture(), { language: 'en' })).rejects.toMatchObject({
      name: 'VoiceTranscriptionError',
      reason: 'stt_failed',
      message: expect.stringContaining('HTTP 500'),
    } satisfies Partial<VoiceTranscriptionError>);
  });

  it('maps an aborted request to cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const runner = new WhisperServerRunner({ baseUrl: 'http://local', model: 'm', fetchFn });
    await expect(
      runner.transcribe(wavFixture(), { language: 'en', signal: controller.signal }),
    ).rejects.toMatchObject({ reason: 'cancelled' });
  });

  it('bounds a wedged HTTP inference like the CLI runner', async () => {
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal;
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return await new Promise<Response>((_resolve, reject) =>
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          ),
        );
      },
    ) as unknown as typeof fetch;
    const runner = new WhisperServerRunner({
      baseUrl: 'http://local',
      model: 'm',
      timeoutMs: 1,
      fetchFn,
    });
    await expect(runner.transcribe(wavFixture(), { language: 'en' })).rejects.toMatchObject({
      reason: 'stt_failed',
      message: expect.stringContaining('exceeded 1 ms'),
    });
  });
});
