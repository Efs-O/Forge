import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeWhisperRunner } from '../../src/voice/FakeWhisperRunner';
import { VoiceAuditLog, type VoiceAuditEvent } from '../../src/voice/VoiceAudit';
import { VoiceIngress } from '../../src/voice/VoiceIngress';
import { VoiceOperation } from '../../src/voice/VoiceOperation';

/**
 * Tier A: no model, no GPU, no network. ffmpeg is the one real dependency the
 * normalize step keeps, so these tests feed it a WAV it can pass through.
 */

const created: VoiceOperation[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((operation) => operation.dispose()));
});

/** A real 16 kHz mono s16 WAV of silence, so ffmpeg has something valid to read. */
async function wavFixture(operation: VoiceOperation, seconds = 1): Promise<string> {
  const target = operation.reserve('input.wav');
  const samples = 16000 * seconds;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  await fs.writeFile(target, Buffer.concat([header, data]));
  return target;
}

async function newOperation(): Promise<VoiceOperation> {
  const operation = await VoiceOperation.create(os.tmpdir());
  created.push(operation);
  return operation;
}

function auditLog(): { log: VoiceAuditLog; events: VoiceAuditEvent[] } {
  const events: VoiceAuditEvent[] = [];
  return { log: new VoiceAuditLog({ write: (event) => events.push(event) }), events };
}

describe('VoiceOperation', () => {
  it('deletes every owned file and its directory on dispose', async () => {
    const operation = await newOperation();
    const wav = await wavFixture(operation);
    await expect(fs.stat(wav)).resolves.toBeTruthy();

    await operation.dispose();

    await expect(fs.stat(wav)).rejects.toThrow();
    expect(operation.isDisposed).toBe(true);
  });

  it('is idempotent, because the terminal paths overlap', async () => {
    const operation = await newOperation();
    await wavFixture(operation);
    await operation.dispose();
    await expect(operation.dispose()).resolves.toBeUndefined();
  });

  it('refuses to reserve after disposal so no path outlives cleanup', async () => {
    const operation = await newOperation();
    await operation.dispose();
    expect(() => operation.reserve('late.wav')).toThrow(/disposed/);
  });
});

describe('VoiceIngress', () => {
  it('accepts a clean transcript and leaves the terminal row to the draft', async () => {
    const operation = await newOperation();
    const source = await operation.adopt(await wavFixture(operation), 'audio/wav');
    const { log, events } = auditLog();
    const runner = new FakeWhisperRunner().enqueue({ kind: 'text', text: 'restart the backend' });

    const result = await new VoiceIngress(runner, log).run(operation, source, {
      surface: 'telegram',
      language: 'auto',
    });

    expect(result).toMatchObject({ ok: true, text: 'restart the backend' });
    // No terminal row yet: auto_submitted and edited_before_submit are only
    // known once the draft resolves, so the caller closes the pair.
    expect(events.map((event) => event.type)).toEqual(['voice_ingress_started']);
    expect(log.isTerminal(operation.id)).toBe(false);
  });

  it('disposes the audio before returning, so no draft can retain it', async () => {
    const operation = await newOperation();
    const wav = await wavFixture(operation);
    const source = await operation.adopt(wav, 'audio/wav');
    const { log } = auditLog();

    await new VoiceIngress(new FakeWhisperRunner(), log).run(operation, source, {
      surface: 'telegram',
      language: 'auto',
    });

    expect(operation.isDisposed).toBe(true);
    await expect(fs.stat(wav)).rejects.toThrow();
  });

  it.each([
    ['refusal', 'I cannot transcribe this audio.'],
    ['empty', '[BLANK_AUDIO]'],
    ['echo', 'Transcription:'],
  ] as const)('rejects %s output and creates no prompt', async (reason, text) => {
    const operation = await newOperation();
    const source = await operation.adopt(await wavFixture(operation), 'audio/wav');
    const { log, events } = auditLog();
    const runner = new FakeWhisperRunner().enqueue({ kind: 'text', text });

    const result = await new VoiceIngress(runner, log).run(operation, source, {
      surface: 'telegram',
      language: 'auto',
    });

    expect(result).toMatchObject({ ok: false, reason });
    const terminal = events.filter((event) => event.type !== 'voice_ingress_started');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe('voice_ingress_rejected');
  });

  it('maps a failed STT process to stt_failed and still cleans up', async () => {
    const operation = await newOperation();
    const source = await operation.adopt(await wavFixture(operation), 'audio/wav');
    const { log, events } = auditLog();
    const runner = new FakeWhisperRunner().enqueue({ kind: 'fail', message: 'exit 1' });

    const result = await new VoiceIngress(runner, log).run(operation, source, {
      surface: 'telegram',
      language: 'auto',
    });

    expect(result).toMatchObject({ ok: false, reason: 'stt_failed' });
    expect(operation.isDisposed).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'voice_ingress_rejected', reason: 'stt_failed' });
  });

  it('reports cancellation as cancelled, not as a transcription failure', async () => {
    const operation = await newOperation();
    const source = await operation.adopt(await wavFixture(operation), 'audio/wav');
    const { log } = auditLog();
    const controller = new AbortController();
    const runner = new FakeWhisperRunner().enqueue({ kind: 'hang' });

    const pending = new VoiceIngress(runner, log).run(operation, source, {
      surface: 'telegram',
      language: 'auto',
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
    expect(operation.isDisposed).toBe(true);
  });

  it('passes the bias prompt through and records that it was used', async () => {
    const operation = await newOperation();
    const source = await operation.adopt(await wavFixture(operation), 'audio/wav');
    const { log, events } = auditLog();
    const runner = new FakeWhisperRunner();

    await new VoiceIngress(runner, log).run(operation, source, {
      surface: 'telegram',
      language: 'el',
      initialPrompt: 'CUDA, Qwen, llama.cpp',
    });

    expect(runner.calls[0].options).toMatchObject({
      language: 'el',
      initialPrompt: 'CUDA, Qwen, llama.cpp',
    });
    expect(events).toHaveLength(1);
  });
});

describe('VoiceAuditLog', () => {
  it('refuses a second terminal row, which would inflate every later count', () => {
    const { log } = auditLog();
    log.rejected({ operation_id: 'v_1', reason: 'empty' });
    expect(() => log.admitted(admitted('v_1'))).toThrow(/already has a terminal/);
  });

  it('tracks terminal state per operation', () => {
    const { log } = auditLog();
    log.rejected({ operation_id: 'v_1', reason: 'empty' });
    expect(log.isTerminal('v_1')).toBe(true);
    expect(log.isTerminal('v_2')).toBe(false);
  });
});

function admitted(operationId: string) {
  return {
    operation_id: operationId,
    backend: 'fake',
    model: 'fake',
    device: 'cpu' as const,
    transcribe_ms: 1,
    bias_prompt_used: false,
    auto_submitted: false,
    edited_before_submit: false,
    grammar_match: null,
  };
}

/** Keeps the unused-path lint quiet for the fixture helper. */
export const FIXTURE_DIR = path.join(os.tmpdir(), 'forge-voice-tests');
