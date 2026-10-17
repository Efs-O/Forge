export interface SilentPcmWavOptions {
  durationSeconds?: number;
  sampleRate?: number;
}

/** A valid 16-bit, mono PCM WAV containing silence. */
export function silentPcmWav({
  durationSeconds = 1,
  sampleRate = 16_000,
}: SilentPcmWavOptions = {}): Buffer {
  const dataLength = Math.floor(durationSeconds * sampleRate) * 2;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}
