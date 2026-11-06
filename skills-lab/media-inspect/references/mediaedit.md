# `mediaedit.py` reference

`mediaedit` makes a measured edit to existing media and reports how it encoded
or changed the result. Both subcommands accept `--json` for one JSON object in
place of the text report.

## `stitch --out OUT [--repeat N] [--crf N] [--min-bytes N] PART PART…`

The input list is concatenated in order and repeated as a whole `N` times
(`--repeat` defaults to 1). Each video is normalized to the first input's
dimensions and frame rate. Audio is resampled to 48 kHz stereo; inputs without
audio receive silence matching their duration so every concat segment has both
tracks. The output uses libx264 at CRF 17, yuv420p, AAC at 192 kb/s and 48 kHz.

The encoder writes `<OUT stem>.part.mp4` beside the destination. It replaces
`OUT` only after the partial file exists and is at least `--min-bytes` bytes
(default 10000); failed or undersized output removes the partial file. The
report includes decoded frame count, fps, duration, audio peak/RMS in dBFS, and
grayscale MAD between the last and first frames. Inputs without audio receive a
silent track matching their duration; the output still has audio, and the
reported peak/RMS describe that encoded track. There is no verdict threshold
for the seam: the measurement is reported for review.

Example text report:

```text
joined.mp4: 192 frames at 24/1 fps, 8.000s
audio: present; peak -6.10 dBFS, RMS -23.40 dBFS; seam MAD 0.2500
```

JSON keys: `output`, `frames`, `fps`, `duration`, `has_audio`,
`audio_peak_dbfs`, `audio_rms_dbfs`, `seam_mad`, `bytes`, `crf`, and
`min_bytes`. The text report also prints CRF and the minimum-size threshold.
Use this when
joining adjacent or repeated clips and checking that the resulting tracks and
boundary are measurable.

## `thinlines --in IMAGE --out PNG --box X0,Y0,X1,Y1 [--axis rows|cols|both]`

Boxes use fractional coordinates in 0..1 unless any coordinate is greater than
1, in which case all coordinates are integer pixels. `--axis` defaults to
`rows`; `cols` scans down columns, and `both` runs both scans. Per scanned line,
the tool finds runs whose mean RGB-channel luma is below `--lum` (default 95),
keeps runs no wider than `--max-run` (default 26 px), and searches up to
`--search` (default 60 px) for unmasked neighbors. Runs touching the image edge
or lacking a neighbor on either side are skipped. Kept spans are filled with a
channel-wise linear ramp, the mask is dilated with a 5×5 maximum filter, then
the repair is feathered with `--feather` (default 1.4 px) and blended only
inside that dilated mask. Pixels outside the box are preserved exactly. PNG
output is written to a temporary name in the same folder and atomically
replaced into `--out`.

The report gives runs seen/kept, masked and painted pixels, and grayscale MAD
between the output box and input box. Every threshold, including `axis`, is
included in the text report. JSON keys: `input`, `output`, `box`, `runs_seen`, `runs_kept`,
`masked_pixels`, `painted_pixels`, `mad_vs_input`, and `thresholds` (`lum`,
`max_run`, `search`, `feather`, `axis`). Use this for narrow dark
scan or rendering lines where the neighboring pixels provide a reasonable
local ramp; inspect the result before relying on it.
