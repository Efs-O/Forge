#!/usr/bin/env node
/**
 * Generates the SYNTHETIC SMOKE half of the voice corpus, and prints the
 * recording script for the half that has to be spoken by a human.
 *
 * Read the warning in test/fixtures/voice/manifest.json before trusting any
 * number that comes out of a synthetic entry. Piper output has no room tone,
 * no breath, no clipping and an espeak-derived phoneme distribution, so a
 * recogniser finds it far easier than real speech. These files prove the
 * pipeline moves bytes end to end. They cannot decide the Phase 0 backend
 * bake-off, cannot set the R2 thresholds, and cannot clear the R3
 * zero-false-authorization gate -- only recorded entries can.
 *
 * Usage:
 *   node scripts/voice-fixtures.mjs --list          print the recording script
 *   node scripts/voice-fixtures.mjs --generate      synthesize the smoke set
 *   node scripts/voice-fixtures.mjs --generate \
 *        --piper <exe> --voices <dir> --ffmpeg <exe>
 *
 * Nothing here is wired into `npm run ci`: it needs Piper and ffmpeg, which are
 * Tier B dependencies (docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §24).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures', 'voice');
const MANIFEST = path.join(FIXTURE_DIR, 'manifest.json');

/** Whisper's input rate. Piper emits 22050 Hz, so a resample is always needed. */
const TARGET_RATE = 16000;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

/**
 * The recording script. Printed rather than generated because the entries that
 * decide Phase 0 are exactly the ones a machine cannot produce.
 */
function list() {
  const { entries } = readManifest();
  console.log('Record each line below as a separate voice note, then save it as');
  console.log(`  ${path.relative(ROOT, FIXTURE_DIR)}/recorded/<id>.wav`);
  console.log('and set that entry\'s "source" to "recorded" in the manifest.\n');
  console.log('Vary the conditions across takes: quiet speech, background noise,');
  console.log('and at least one delayed/replayed note (R3).\n');
  for (const entry of entries) {
    if (!entry.text) continue;
    console.log(`[${entry.id}]  (${entry.language})`);
    console.log(`    "${entry.text}"`);
  }
  console.log(`\n${entries.filter((e) => e.text).length} utterances.`);
}

function synthesize({ piper, voices, ffmpeg }) {
  const { entries } = readManifest();
  const outDir = path.join(FIXTURE_DIR, 'synthetic');
  fs.mkdirSync(outDir, { recursive: true });
  let made = 0;

  for (const entry of entries) {
    const target = path.join(outDir, `${entry.id}.wav`);
    if (entry.source === 'generated-silence') {
      // A real silent WAV, not a Piper artifact: the point is that no speech
      // reaches the recogniser at all.
      execFileSync(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `anullsrc=r=${TARGET_RATE}:cl=mono`,
        '-t',
        String(entry.durationSeconds ?? 2),
        '-c:a',
        'pcm_s16le',
        target,
      ]);
      made += 1;
      continue;
    }
    if (entry.source !== 'synthetic') continue;

    const model = path.join(voices, `${entry.voice}.onnx`);
    if (!fs.existsSync(model)) {
      console.error(`skip ${entry.id}: missing voice ${model}`);
      continue;
    }
    const raw = path.join(outDir, `${entry.id}.piper.wav`);
    execFileSync(piper, ['--model', model, '--output_file', raw], {
      input: entry.text,
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    // Resample to what Whisper wants, and append trailing silence for the
    // entries that exist to reproduce the §27.1 hallucination trigger.
    const pad = entry.trailingSilenceSeconds
      ? ['-af', `apad=pad_dur=${entry.trailingSilenceSeconds}`]
      : [];
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      raw,
      ...pad,
      '-ac',
      '1',
      '-ar',
      String(TARGET_RATE),
      '-c:a',
      'pcm_s16le',
      target,
    ]);
    fs.rmSync(raw, { force: true });
    made += 1;
  }

  console.log(`Wrote ${made} synthetic fixtures to ${path.relative(ROOT, outDir)}`);
  console.log('SMOKE ONLY -- these cannot decide the backend bake-off (§6.1) or');
  console.log('clear the R3 gate. Record the human corpus with --list.');
}

const mode = process.argv.includes('--generate') ? 'generate' : 'list';
if (mode === 'list') {
  list();
} else {
  synthesize({
    piper: arg('piper', 'N:/vs code apps/Gemma4kids/piper/win/piper.exe'),
    voices: arg('voices', 'N:/vs code apps/Gemma4kids/voices'),
    ffmpeg: arg('ffmpeg', 'C:/ffmpeg/ffmpeg.exe'),
  });
}
