# `imgprobe.py` reference

`imgprobe` measures existing still images. Boxes use fractional coordinates in
0..1 unless any coordinate is greater than 1, in which case all coordinates are
integer pixels. The selected box is clamped to the image. Measurement commands
accept `--json` to print one JSON object instead of the text report.

## `color IMAGE --box X0,Y0,X1,Y1`

Choose exactly one of `--target R,G,B` and `--reference IMAGE`. The tool crops
the middle half of the box (one-quarter inset on each side), resizes it to
48×48 with Lanczos, and reports the mean RGB and Euclidean RGB distance to the
target. `--tol NEAR,FAR` defaults to `40,70`: distance at or below the first is
`near`, distance at or above the second is `far`, and values between them are
`between`. The thresholds and verdict are always printed.

Example text report:

```text
mean RGB: (190.0, 190.0, 190.0)
target RGB: (190.0, 190.0, 190.0) (explicit target)
distance: 0.000; tol near <= 40, far >= 70; near
```

JSON keys: `image`, `box`, `mean_rgb`, `target_rgb`, `target_source`,
`distance`, `tolerance` (`near`, `far`), and `verdict`. Use this when a region's
colour needs a repeatable comparison against a target or reference image.

## `black IMAGE --box X0,Y0,X1,Y1`

`--black-max` defaults to 60. A pixel is counted when its maximum RGB channel
is strictly below that value. Repeat `--compare IMAGE` for comparison images;
the first image is the reference and the report includes the largest comparison
minus reference share in percentage points. `--delta` defaults to 1.0 pp and
is printed with the result. This measures dark-area share, not subjective
brightness.

Example text report:

```text
reference.png: 0.000% below max-channel 60
edited.png: 10.000% below max-channel 60
worst compare delta: +10.000 pp; threshold 1 pp; exceeds
```

JSON keys: `box`, `black_max`, `delta_threshold_pp`, `images` (each has `image`
and `black_percent`), `reference`, `worst_compare_delta_pp`, and `verdict`. Use
this when checking how much of a defined region falls below a chosen dark
threshold.

## `diff FIRST SECOND [--box X0,Y0,X1,Y1]`

Reports grayscale mean absolute difference (MAD), in 0..255 luma levels. The
second crop is independently resolved from the same box coordinates. Without
a box, the full images are compared; differing sizes are resized by the shared
`mediakit.mad` helper. JSON keys: `first`, `second`, `box`, and `mad`. Use this
when a numeric still-to-still change is more useful than a visual comparison.

## `meta show IMAGE [--chunk KEY]`

Lists PNG text chunks as `key (length bytes): text`; `--chunk` selects one key.
JSON keys are `image` and `chunks` (each has `key`, `length`, and `text`). Use
this when checking whether a PNG carries a prompt, comment, or other text
metadata.

## `meta dump FOLDER --out DIR [--chunk KEY]`

Writes one UTF-8 text file per matching PNG text chunk, named
`<stem>.<key>.txt`. Unsafe filename characters in keys are replaced with `_`.
Repeated keys in one PNG receive a numeric suffix. Existing paths are never
overwritten; a collision is an error. JSON keys are
`folder` and `files` (each has `path`, `key`, and `length`). Use this when the
text itself needs to be inspected or archived separately from the PNG.
