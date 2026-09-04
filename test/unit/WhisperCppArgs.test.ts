import { describe, expect, it } from 'vitest';
import { buildWhisperArgs, type WhisperCppOptions } from '../../src/voice/WhisperCppRunner';

/**
 * Covers the `voice.compute:` flag mapping.
 *
 * Worth a test despite being a flag table: a wrong `-dev` produces a perfectly
 * correct transcript off the wrong card, so nothing downstream can catch it. The
 * argv is the only observable.
 */

const base: WhisperCppOptions = { binary: 'whisper-cli.exe', model: 'ggml-large-v3.bin' };
const args = (options: Partial<WhisperCppOptions>): string[] =>
  buildWhisperArgs({ ...base, ...options }, 'audio.wav', { language: 'auto' });

describe('buildWhisperArgs', () => {
  it('sends only model, audio, language and quiet flags when nothing is configured', () => {
    expect(args({})).toEqual([
      '-m',
      'ggml-large-v3.bin',
      '-f',
      'audio.wav',
      '-l',
      'auto',
      '-np',
      '-nt',
    ]);
  });

  it('pins a GPU ordinal with -dev', () => {
    expect(args({ gpuDevice: 1 })).toContain('-dev');
    expect(args({ gpuDevice: 1 })).toEqual(expect.arrayContaining(['-dev', '1']));
  });

  it('accepts device 0, which is falsy but a real ordinal', () => {
    expect(args({ gpuDevice: 0 })).toEqual(expect.arrayContaining(['-dev', '0']));
  });

  it('forces CPU with -ng', () => {
    expect(args({ useGpu: false })).toContain('-ng');
  });

  it('never sends -dev alongside -ng', () => {
    const cpu = args({ useGpu: false, gpuDevice: 1 });
    expect(cpu).toContain('-ng');
    expect(cpu).not.toContain('-dev');
  });

  it('still pins the device when gpu is explicitly true', () => {
    expect(args({ useGpu: true, gpuDevice: 2 })).toEqual(expect.arrayContaining(['-dev', '2']));
  });

  it('maps threads, beam size and flash attention', () => {
    const tuned = args({ threads: 8, beamSize: 1, flashAttn: false });
    expect(tuned).toEqual(expect.arrayContaining(['-t', '8', '-bs', '1', '-nfa']));
    expect(tuned).not.toContain('-fa');
  });

  it('sends -fa when flash attention is explicitly on', () => {
    expect(args({ flashAttn: true })).toContain('-fa');
  });

  it('keeps the bias prompt last so a truncated argv loses it first', () => {
    const withPrompt = buildWhisperArgs({ ...base, gpuDevice: 1 }, 'audio.wav', {
      language: 'el',
      initialPrompt: 'VRAM, CUDA',
    });
    expect(withPrompt.slice(-2)).toEqual(['--prompt', 'VRAM, CUDA']);
    expect(withPrompt).toEqual(expect.arrayContaining(['-l', 'el']));
  });
});
