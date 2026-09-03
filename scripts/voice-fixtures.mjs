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
  const spoken = entries.filter((entry) => entry.text);
  console.log('HOW TO RECORD\n');
  console.log('  1. Record each line below as a separate clip, any recorder,');
  console.log('     any format (.m4a .ogg .oga .mp3 .wav .opus all work).');
  console.log('     A phone voice recorder or a Telegram voice note to yourself');
  console.log('     is ideal -- that is the microphone the feature will use.');
  console.log('  2. Name each file after the id in [brackets], e.g. "en-cmd-approve.m4a".');
  console.log('  3. Put them all in one folder and run:\n');
  console.log('       node scripts/voice-fixtures.mjs --import <that folder>\n');
  console.log('     That converts to 16 kHz mono WAV, files them under');
  console.log(`     ${path.relative(ROOT, FIXTURE_DIR)}/recorded/, and flips each`);
  console.log('     entry to source:"recorded" in the manifest. No ffmpeg needed by hand.\n');
  console.log('  Partial batches are fine -- import as many as you record.\n');
  console.log('WHAT TO VARY (R3): most at a normal speaking volume, but do a few');
  console.log('  quietly, a few with background noise, and re-send one clip a second');
  console.log('  time as a delayed/replayed note. The negation lines matter most:');
  console.log('  they are what prove a misheard word cannot authorize an action.\n');
  console.log('LINES TO RECORD\n');
  for (const entry of spoken) {
    const done = entry.source === 'recorded' ? '  [done]' : '';
    console.log(`[${entry.id}]  (${entry.language})${done}`);
    console.log(`    "${entry.text}"`);
  }
  const remaining = spoken.filter((entry) => entry.source !== 'recorded').length;
  console.log(`\n${spoken.length} utterances, ${remaining} still to record.`);
}

/**
 * Converts whatever the user recorded into the corpus.
 *
 * Deliberately format-agnostic: the point of the recorded corpus is that a
 * human speaks into a real microphone, and making them fight ffmpeg first is a
 * good way to end up with no corpus at all. Anything ffmpeg can decode is fine.
 */
function importRecordings(sourceDir, { ffmpeg }) {
  const manifest = readManifest();
  const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const outDir = path.join(FIXTURE_DIR, 'recorded');
  fs.mkdirSync(outDir, { recursive: true });

  let imported = 0;
  const unmatched = [];
  for (const file of fs.readdirSync(sourceDir)) {
    const id = path.basename(file, path.extname(file));
    const entry = byId.get(id);
    if (!entry) {
      unmatched.push(file);
      continue;
    }
    const target = path.join(outDir, `${id}.wav`);
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      path.join(sourceDir, file),
      '-ac',
      '1',
      '-ar',
      String(TARGET_RATE),
      '-c:a',
      'pcm_s16le',
      target,
    ]);
    // Only the manifest says which entries count for Phase 0, so flipping this
    // flag is the whole point of the import -- not the file copy.
    entry.source = 'recorded';
    imported += 1;
  }

  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Imported ${imported} recordings to ${path.relative(ROOT, outDir)}`);
  if (unmatched.length) {
    console.log(`\nSkipped ${unmatched.length} file(s) whose name matched no manifest id:`);
    for (const file of unmatched) console.log(`  ${file}`);
    console.log('Rename them to the id in [brackets] from --list.');
  }
  const left = manifest.entries.filter((e) => e.text && e.source !== 'recorded');
  console.log(`\n${left.length} utterance(s) still synthetic. Run --list to see which.`);
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

const ffmpeg = arg('ffmpeg', 'C:/ffmpeg/ffmpeg.exe');
const importDir = arg('import', undefined);

if (importDir) {
  importRecordings(importDir, { ffmpeg });
} else if (process.argv.includes('--generate')) {
  synthesize({
    piper: arg('piper', 'N:/vs code apps/Gemma4kids/piper/win/piper.exe'),
    voices: arg('voices', 'N:/vs code apps/Gemma4kids/voices'),
    ffmpeg,
  });
} else {
  list();
}
