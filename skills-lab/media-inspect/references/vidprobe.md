# `vidprobe.py` reference

`vidprobe.py CLIP SUBCOMMAND [flags]` — one clip, one measurement per call. Every
subcommand prints a short text report; add `--json` for one JSON object on stdout in
place of it. A `--box` is `x0,y0,x1,y1` as a fraction of the canvas by default; if any
value is greater than 1 all four are integer pixels. Frame rate is always read from the
file with `ffprobe`; `--fps` only overrides it.

Motion is ffmpeg's `signalstats` **YDIF**: the average absolute brightness change between
a frame and the one before it. It measures visible movement, not direction, and it is
large in the middle of a traversal and near zero at a reversal.

Exit codes: `0` measured, `2` bad arguments, `3` missing dependencies, `4` unreadable
input. A verdict never changes the exit code.

---

## `probe` — canvas, fps, frames, duration, audio presence

Flags: `--fps`, `--json`.

```
canvas: 320x240
fps: 24.000 (24/1)
frames: 96
duration: 4.000 s
audio: no
```

JSON: `canvas` `[width, height]`, `fps`, `fps_fraction`, `frames`, `duration`,
`has_audio`.

Reach for it before anything else, so every later `--box` is a fraction of a canvas you
have actually read.

---

## `stats` — one-line motion summary and audio level

Flags: `--box`, `--json`.

```
motion: mean 0.756  median 0.799  p90 1.141  max 1.363 (frame 42, t 1.750 s)
audio: mean -16.8 dB  peak -5.7 dB
```

A clip with no audio track prints `audio: none in this clip` instead of numbers. The
audio numbers come from ffmpeg's `volumedetect` filter.

JSON: `box` (or `null`), `motion` `{mean, median, p90, max, argmax}`, and `audio`
`{mean_db, peak_db}` or `null`.

Use it to answer "is anything moving at all, and how loud is this" in one pass.

---

## `frames` — every frame's motion value, plus flagged frames and runs

Flags: `--out PATH` (required), `--factor 2.2`, `--box`, `--fps`, `--json`.

The TSV holds one row per frame — a `#` comment line naming the columns and the threshold
it used, then rows of `frame`, `time_s`, `motion` separated by tabs:

```
# frame	time_s	motion	(one row per frame; threshold 1.662 = mean 0.756 x factor 2.20)
0	0.000	0.000
1	0.042	0.458
```

The report prints the threshold, the top 20 flagged frames with their time, and runs of
two or more frames:

```
wrote: rows.tsv (96 rows, one per frame)
threshold: 0.907 (mean 0.756 x factor 1.20)
flagged: 48 frames above 0.907
top 20 by value:
  frame 42 (t 1.750 s): 1.363
runs of 2 or more: 8
  frames 3-8: 6 frames, peak 1.362
```

When nothing clears the threshold the report says so rather than printing nothing:

```
flagged: none above 1.662; max 1.363 at frame 42 (t 1.750 s)
runs: none of 2 or more
```

JSON: `out`, `rows`, `box`, `factor`, `threshold`, `flagged_count`, `top`
`[{frame, time_s, value}]`, `runs` `[{start, end, frames, peak}]` (start and end are
inclusive frame indices).

Reach for it when a change may last one frame: a flash, a glitch, a single dropped
motion frame. A frame is flagged when its value is above the mean of the measured series
(the box's mean when `--box` is given) times `--factor`, so a busy clip needs a factor
near 1.2 and a still clip needs a small one.

---

## `region` — motion inside a box against the whole frame

Flags: `--box` (required), `--ratio 1.3`, `--json`.

```
box: 0.5,0,1,1 -> 160,0,320,240 px
region mean motion: 1.511
whole mean motion: 0.756
WHERE region (ratio 2.00 > 1.30)
```

The ratio is the region mean over the whole-frame mean, so it is 1.0 when the box moves
exactly as much as the clip does. The verdict line always names the threshold it used:

- `WHERE region (ratio R > T)` — the box moves more than the whole frame by the margin you asked for.
- `NOT WHERE region (ratio R < 1.00; the box moves less than the whole frame)` — the box is quieter than the clip.
- `NEUTRAL region (ratio R is between 1.00 and T)` — the box matches the clip, so the motion is spread out, not concentrated.
- `NOT WHERE: no motion anywhere ...; ratio undefined` — the whole clip is still, so no ratio exists.

JSON: `box`, `region_mean`, `whole_mean`, `ratio` (or `null`), `ratio_threshold`,
`verdict` (`WHERE`, `NOT WHERE`, `NEUTRAL`), `line`.

Reach for it when the question is "does the subject move, or only the camera": run it
once on the middle of the frame and once on a strip you expect to be static.

---

## `cycle` — the repeat period of the motion in a box

Flags: `--box`, `--min-period 12`, `--corr 0.40`, `--json`.

```
min period: 12 frames
  lag 12 frames (0.500 s): r 0.933 (score 0.873)
  lag 24 frames (1.000 s): r 0.967 (score 0.837)
  lag 36 frames (1.500 s): r 0.939 (score 0.742)
cycle: period 12 frames (0.500 s) at r 0.933 > 0.40
```

The top three candidates are always printed, even when none clears `--corr`, so a
missing verdict line is never read as "no period":

```
cycles: none above r 0.40; best r 0.00 at lag 12
```

`r` is the Pearson correlation of the motion series against itself shifted by that many
frames. `score` is `r` discounted by how much of the clip that lag can actually compare
(`sqrt((frames - lag) / frames)`), because a lag near half the clip length has only half
a clip left to disagree with and routinely scores high on a clip that repeats twice. The
candidates are ranked by `score`; `--corr` is checked against the raw `r` of the winner.

Which lag you get on a back-and-forth motion: a box that travels across and back has a
position period of 24 frames, but YDIF only measures how much is moving, and the forward
and backward traversals look the same, so a motion-only tool reports the 12-frame half
period. Both are correct readings of the same clip; take `--min-period` above the half
period if you want the full one.

JSON: `box`, `min_period`, `corr`, `candidates` `[{lag, r, score}]`, `best_lag`,
`best_r`, `period_s`, `verdict`.

Reach for it on a loop: it tells you how long one turn of the cycle is, and a low `best_r`
means the clip does not repeat at all.

---

## `sync` — sound-to-motion lag

Flags: `--box`, `--max-lag-ms 300`, `--top 8`, `--floor-share 0.20`, `--corr 0.20`,
`--fps`, `--json`.

```
motion onsets: 8 (floor 0.273 = 0.20 x max 1.363)
audio onsets: 8 (floor 0.0708 = 0.20 x max 0.3541)
scan: lag -8..8 frames (-333.3..333.3 ms at 24.000 fps)
  lag 2 (83.3 ms): r 0.843
  lag -2 (-83.3 ms): r -0.067
lag: 2 frames at r 0.843 > 0.20; sound late by 2 frames (83.3 ms)
```

Both sides are onset detectors, so the comparison is start-to-start. An onset is a frame
where a series rises to `--floor-share` of its own maximum after having been below it —
the start of each moving or each loud stretch — and each onset is weighted by the
positive first difference of the log of that series at the onset frame, which is how
strongly it stands out. The motion series is the per-frame YDIF (cropped to `--box` when
given); the audio series is the per-frame RMS envelope of the decoded track. The scan
correlates the two at every lag inside `--max-lag-ms` and prints the `--top` best.

The sign is spelled out and means what it says: a positive lag is the number of frames
the sound comes in **after** the motion it belongs to, so `sound late by 2 frames` means
you would need to delay the audio track by 83.3 ms to line them up. A negative lag is
`sound early by N frames`. A lag of 0 is `sound and motion onset together`.

If the best correlation does not clear `--corr`, the report says
`lag: none above r 0.20; best r ...; Do not read this as a lag.` and a clip with no
audio track says `sync: this clip has no audio track, so there is nothing to correlate`.
A clip that never goes quiet between movements produces no motion onsets, and the report
says `onsets: none to correlate` rather than inventing a lag.

One frame of warning about the motion side: YDIF first registers a reversal one frame
after it happens, so a sound that starts exactly three frames after a reversal measures
as two frames late. Read the number as the offset between the two onset series, not as a
count of frames from the visual event itself.

JSON: `box`, `floor_share`, `motion_onsets`, `audio_onsets`, `max_lag_frames`, `corr`,
`candidates` `[{lag, ms, r}]`, `lag_frames` (signed, or `null`), `lag_ms`, `best_r`,
`verdict`.

Reach for it when a clip was assembled from a separate sound recording, or when a
generated clip's audio looks misaligned with the movement.

---

## `audio` — peak and RMS in dBFS, and RMS per fifth of the clip

Flags: `--fps`, `--json`.

```
peak: -5.7 dBFS
rms:  -16.8 dBFS
rate: 48000 Hz, 192512 samples, 4.011 s
fifths by rms (loudest first):
  fifth 1 (0.000-0.802 s): -15.9 dBFS
  fifth 3 (1.604-2.406 s): -15.9 dBFS
  fifth 4 (2.406-3.208 s): -15.9 dBFS
  fifth 2 (0.802-1.604 s): -18.9 dBFS
  fifth 5 (3.208-4.011 s): -18.9 dBFS
```

The fifths are equal sample ranges of the decoded track, printed loudest first so the
loud part of the clip is the first line you read. A clip with no audio track prints
`audio: none in this clip`.

JSON: `peak_dbfs`, `rms_dbfs`, `sample_rate`, `samples`, `duration_s`, `fifths`
`[{index, t0, t1, rms_dbfs}]` (`index` is 1-based, `t0`/`t1` are seconds).

Reach for it to find where the sound is, as opposed to how loud the whole clip is.

---

## `loudness` — this clip's level, and the signed difference against other clips

Flags: `--compare CLIP` (repeatable), `--json`. Audio only: there is no `--box`.

```
clip: beep.mp4
  mean: -16.8 dB  peak: -5.7 dB  rms: -16.8 dBFS
compare: beep_quiet.mp4
  mean: -22.8 dB  peak: -11.8 dB  rms: -22.8 dBFS
  difference: -6.0 dB quieter (rms dBFS against this clip)
```

`mean` and `peak` come from `volumedetect`; `rms` is computed from the decoded samples.
The `difference` line is the other clip's RMS minus this clip's, so a negative number is
quieter and a positive one is louder, and it always names the metric it used.

A clip with no audio track prints `audio: none in this clip` instead of numbers, and a
comparison against one says `difference: not measurable (no audio to compare)`; if the
clip you asked about is the silent one, it says `difference: not comparable (this clip
has no audio)`.

JSON: `clip`, `mean_db`, `peak_db`, `rms_dbfs` (any may be `null`), `compare`
`[{clip, audio, mean_db, peak_db, rms_dbfs, difference_db}]` — `difference_db` is
present only when both clips have audio.

Reach for it when one clip in a set sounds different from the others and you want the
gap in decibels rather than an opinion.

---

## `seam` — grayscale MAD of the first frame against the last

Flags: `--first IMG`, `--last IMG`, `--floor`, `--json`.

```
first vs last: 0.272
```

The number is the mean absolute difference of the two frames' grayscale, in 0..255
brightness units, so 0 means the two frames are the same picture. `--first IMG` compares
a still you supply against frame 0, and `--last IMG` against the last frame — useful for
checking that a loop's first and last frames match a key image:

```
--first image vs frame 0: 61.966
```

`--floor` re-encodes the clip to a temporary file with libx264 at CRF 10 and measures the
same pair again, which is the level of difference a high-quality re-encode alone would
leave between those frames. Differences at or below that floor are encoding noise, not a
visible seam:

```
floor (libx264 crf 10 re-encode, 96 frames): first vs last 0.273
```

If the re-encode itself fails, the run exits 4 with `ffmpeg re-encode failed:` and
ffmpeg's last error line.

JSON: `first_last`, `first_image`, `last_image` (the last two are `null` without the
matching flag), `first_frame`, `last_frame`, and with `--floor` also `floor`
`{first_last, first_image, last_image}` and `floor_crf`.

Reach for it on a loop, or to check that a clip begins and ends on the frame you think it
does: `seam --floor` separates a real seam from re-encode noise.
