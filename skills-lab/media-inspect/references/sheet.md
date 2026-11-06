# `sheet.py` reference

`python scripts/sheet.py MODE ...` builds contact sheets. Every mode needs
`--out`; nothing is written anywhere else, and the tool removes its own temp
files on every exit path. Exit codes: 0 written, 2 bad arguments, 3 missing
dependencies, 4 unreadable input. A sheet is evidence for a human to read; it
makes no verdict and encodes no threshold.

Boxes are fractions of width and height (0..1); if any coordinate is above 1,
all four must be integer pixels. Frame rate comes from the file.

| Mode | Reach for it when |
|---|---|
| `video` | you want to see sampled moments across a clip, or a close-up of one region lined up against the whole frame |
| `images` | you need a folder of stills numbered so someone can say "tile 17" and mean it |
| `grid` | you need fine detail inside named regions, or the same rows of two images side by side |

---

## `sheet.py video <clip>`

A sheet of frames over a time window, each tile labelled with its frame number
and time, optionally cropped and magnified.

| Flag | Default | Meaning |
|---|---|---|
| `--window lo-hi` | whole clip | seconds; if `hi` passes the clip end it is clamped and a `note:` line says so |
| `--step N` | `2` | every Nth frame inside the window |
| `--count N` | unset | N frames spread evenly over the window; reduces N when the window holds fewer frames, with a `note:` line. Exclusive with `--step` |
| `--box x0,y0,x1,y1` | unset | crop every tile to this region |
| `--zoom F` | `1.0` | show the centre `1/F` of the region, so `2.0` doubles magnification. Clamped to the canvas |
| `--crop-twin` | off | also write `<stem>-crop.png`: the same frames, same order, cropped to `--box`. With this flag `--box` applies to the twin only, so the primary sheet stays a whole-frame view and the two sheets line up tile for tile |
| `--exact` | off | decode each frame on its own instead of in one pass; the frame indices are identical either way |
| `--cols N` | `5` | tiles per row; short rows are padded, so the grid stays aligned |
| `--tile-w N` | `320` | tile width in px; height keeps the source aspect |
| `--out PATH` | required | sheet PNG; `.png` is appended if the name has no suffix |
| `--json` | off | one JSON object instead of the text report |

`--crop-twin` without `--box` is an argument error.

### Text output

```
clip clip.mp4 320x240 24/1 fps 96 frames
window 0.000-4.000 s -> 12 tiles; sampling: step 8 over frames 0-95
layout: cols 5, tile-w 320, label-h 22, exact off
primary region: whole frame 0,0,320,240 zoom 1
twin region: 160,0,320,240 zoom 1
wrote C:\out\sheet.png 1600x786px 10280 bytes tiles=12
wrote C:\out\sheet-crop.png 1600x1004px 12263 bytes tiles=12
note: window clamped to clip length: 1.000-4.000 s of 4.000 s
```

The `region:` lines print the region actually shown after `--zoom`, so the
magnified area is never a guess. `tiles=` is the number of frames on that sheet.

### JSON keys

`mode`, `clip`, `width`, `height`, `fps`, `fps_fraction`, `frames`,
`duration_s`, `window_s`, `sampling` (`{"step": N}` or `{"count": N}`),
`frame_indices`, `tiles`, `cols`, `tile_w`, `box`, `zoom`, `exact`,
`crop_twin`, `regions` (`{"primary": "...", "twin": "..."}` or `null`),
`written` (each `{path, width, height, bytes, tiles}`), `notes`.

---

## `sheet.py images <files...>`

A numbered sheet of stills in letterboxed square cells, so portrait and
landscape sources sit in the same grid.

| Flag | Default | Meaning |
|---|---|---|
| `files...` | - | the images, in the order to number them |
| `--order-file PATH` | unset | one path per line (`#` comments and blanks ignored); relative entries resolve against the file's own folder. Use instead of the arguments, not with them |
| `--cols N` | `5` | cells per row |
| `--rows N` | `7` | cells per sheet, so `cols * rows` images fit on one page |
| `--cell N` | `340` | square cell size in px |
| `--number-from N` | `1` | first number, for continuing a set that already exists |
| `--manifest` | off | also write `<stem>-manifest.md` mapping number to file |
| `--out PATH` | required | first-page sheet; later pages are `<stem>-2.png`, `<stem>-3.png` |
| `--json` | off | one JSON object instead of the text report |

### Text output

```
3 images in cells of 340px, cols 5, rows 7, numbering from 1, per sheet 35, 1 sheet(s)
wrote C:\out\set.png 1700x362px 4062 bytes tiles=3
wrote C:\out\set-manifest.md 231 bytes rows=3
```

The manifest is a two-column markdown table; `rows=` is the number of images it
maps, and the numbers in it are the numbers printed under the cells.

### JSON keys

`mode`, `count`, `cols`, `rows`, `cell`, `number_from`, `per_sheet`, `pages`,
`order_file`, `manifest`, `numbers` (list of `{number, file}` in order),
`written`, `notes`.

---

## `sheet.py grid <img...>`

Magnified crops of named regions, paged so each sheet stays readable, with a
whole-image map of where each crop came from.

| Flag | Default | Meaning |
|---|---|---|
| `img...` | - | one or more images; with several, every region is sheeted for every image and labelled `file:region` |
| `--region name:x0,y0,x1,y1` | - | a named region; repeat for more |
| `--region-file PATH` | - | `.json` object mapping name to a box string or a 4-number list, or flat `name: x0,y0,x1,y1` lines with `#` comments |
| `--preset thirds\|halves\|center` | - | neutral geometry only; repeatable. `thirds` is a 3x3 grid (9 regions, `thirds_r1c1`...), `halves` is 2x2, `center` is the middle half |
| `--bands y0-y1,y0-y1` | - | the same horizontal bands across images, one sheet per band, images side by side. Replaces the region list |
| `--scale F` | `3.0` | crop magnification; upscaled with nearest-neighbour so pixel edges stay honest |
| `--per-sheet N` | `3` | most tiles on one sheet |
| `--max-width N` | `1600` | sheet width cap in px; tile width is `min(widest crop, max-width // tiles-per-sheet)` |
| `--overview F` | `0.5` | add a labelled whole-image map row at the top of every sheet with every region outlined. Width is `min(image width, F * max-width)`, so it never upscales. `0` disables it |
| `--out STEM` | required | pages are `<stem>-1.png`, `<stem>-2.png`; a `.png` suffix is accepted and stripped |
| `--json` | off | one JSON object instead of the text report |

Region order is the `--region` flags first, then the `--region-file`, then the
presets. Fraction boxes scale to each image; pixel boxes do not, so prefer
fractions when the images differ in size. Tiles are padded to the tallest
aspect on the sheet so cells line up across pages. `--bands` turns the overview
off (every tile already spans the width) and says so in a `note:` line. If a
crop's scaled width is wider than `max-width` divided by the tiles per sheet,
the tile is scaled down to fit, so the magnification you see is lower than
`--scale`; the printed `tile-w` is the width actually used.

### Text output

```
9 region(s): thirds_r1c1 0.0000,0.0000,0.3333,0.3333, thirds_r1c2 ...
layout: scale 3, per-sheet 3, max-width 1600, overview 0.5, label-h 22
image C:\fixtures\a.png 200x200
tile-w 201px, 3 sheet(s) of up to 3 tiles
wrote C:\out\thirds-1.png 603x449px 4172 bytes tiles=3
wrote C:\out\thirds-2.png 603x449px 4234 bytes tiles=3
wrote C:\out\thirds-3.png 603x449px 4188 bytes tiles=3
```

### JSON keys

`mode`, `images`, `regions` (list of `{name, box}`), `scale`, `per_sheet`,
`max_width`, `overview`, `tile_w`, `sheets`, `written`, `notes`. Band mode
reports `bands` (the tokens) instead of `regions`, and omits `tile_w` because
it changes per band.

---

## Examples

```
# whole clip at every 12th frame, plus a close-up of the right half
python scripts/sheet.py video clip.mp4 --step 12 --crop-twin --box 0.5,0,1,1 --out right-half.png

# one region, magnified: the centre of a still
python scripts/sheet.py grid frame.png --region centre:0.4,0.4,0.6,0.6 --scale 6 --out centre

# the same rows of a generated clip against its reference still
python scripts/sheet.py grid out.png ref.png --bands 0.35-0.65 --out band-compare

# number a folder of stills, continuing from a sheet that already exists
python scripts/sheet.py images --order-file order.txt --number-from 36 --manifest --out batch-2.png
```
