import type { NormalizeStep } from '../../src/voice/VoiceIngress';

/**
 * A normalize step that hands the source audio straight through.
 *
 * The real one in `AudioNormalizer` spawns ffmpeg. Unit tests that walk the
 * voice ingress path do not care what the samples look like -- `FakeWhisperRunner`
 * never reads them -- but they inherited the dependency anyway, so the whole
 * suite silently required an ffmpeg on PATH. That passed on a developer machine
 * with one installed and failed on all three CI runners, which install none:
 * every Publish and CI run from 0.15.13 to 0.15.27 was red for this reason
 * alone, and the symptom (`stt_failed`, or a spoken approval that resolves
 * nothing) named the recogniser rather than the missing binary.
 *
 * Tests that mean to exercise the conversion itself should call `normalizeToWav`
 * directly and skip when no ffmpeg is present, rather than reaching for this.
 */
export const passthroughNormalize: NormalizeStep = async (_operation, source) => source;
