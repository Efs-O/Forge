---
name: blender
description: Build, render and check Blender scenes headless from Python scripts — find Blender, brief, build, look, grade by numbers, export GLB. Any 3D, .blend or render job.
---

# blender

Drive Blender from Python, never from the mouse. No GUI, no add-on, no MCP bridge:
every stage is a script run headless, and the loop is
**brief → build → look → fix → check → export → verify**. The loop only works
because each stage prints numbers.

Nothing in this folder knows a machine: no install path, no drive letter, no GPU
name. Scripts next to this file are `scripts/find_blender.py`, `scripts/bkit.py`,
`scripts/image_stats.py`, `scripts/smoke.py` — substitute the folder `load_skill`
prints for `<skill>` below.

## The method

1. **Find Blender** once, and remember the path for the rest of the chat. Never
   search a drive for it:

   ```text
   python <skill>/scripts/find_blender.py
   ```

   It prints the executable path, or exits 1 with `Blender not found. Set BLENDER
   to the blender executable, or add it to PATH.` A portable install lives where no
   search path can find it, so then ask the user for it and set `BLENDER`.

2. **Everything runs headless:**

   ```text
   "<blender>" -b -P scripts/01_build.py -- --out scene/build.blend
   ```

   One script per stage, kept in the workspace under `scripts/`, numbered, so any
   stage can be rerun alone. Arguments after `--` reach the script's `sys.argv`.

3. **Copy `scripts/bkit.py` from the skill into the workspace's `scripts/` once**,
   and import it from there — the skill's own folder moves with each Forge update:

   ```python
   import os, sys
   sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
   import bkit
   ```

   `bkit` holds the mesh, material, UV, card, report, export and render helpers.
   Start every scene with `bkit.metric(scene)`: work in metres.

4. **Brief first.** Write the numbers down before modelling — sizes in metres, tri
   budget, object and material names, engine target — and mark which are measured
   and which are derived. Solve dimensions (an arch's spring height and radius, a
   taper's scale height) instead of eyeballing them: eyeballed dimensions are what
   the look step then rejects.

5. **Build, then check the build:** `bkit.report(objects, "stage name")`. It prints
   mesh count, tri count, bounds, size and `issues=`. Print `issues=` from a real
   measurement, never write "looks fine": a bowtie quad, an off-by-one face index
   or an unapplied scale are silent otherwise.

6. **Look step — not decoration.** Render previews from several angles (front,
   side, iso, wireframe) into one folder and *look at them* (`view_image`). It has
   caught four real defects — a needle-thin taper, undersized arches, a clipped
   camera, washed-out colour — that every numeric check had passed.

7. **Render into the workspace**: `renders/<look>/`, one folder per render set, so
   `send_file` and `view_image` can reach the files and the sets never overwrite
   each other.

8. **Grade by numbers, not by thumbnail:**

   ```text
   "<blender>" -b -P <skill>/scripts/image_stats.py -- renders/look/hero_01.png
   ```

   It prints `mean / p50 / p95 / clip>0.995` measured from the file's own pixels.
   A small image sent back through a chat lies about contrast; these numbers
   compare one variant of a look with the next.

9. **Export, then read it back:** `bkit.export_glb(path, objects)` then
   `bkit.reimport_check(path)`. The triangle counts, materials and bounds the
   re-import reports must match the `report` numbers — that is the engine's view of
   the file. Run `bkit.clean_names()` first: `Cube.017` becomes an engine name.

10. **GPU:** by default every device Cycles finds is used (`bkit.use_gpus`). If the
    machine's GPUs are busy serving a model, set `BKIT_GPU_INCLUDE` or
    `BKIT_GPU_EXCLUDE` (comma lists of device-name substrings) before the render, or
    ask the user which card is free. When nothing matches it falls back to CPU, and
    says so.

11. **Long renders:** run them with `background: true`. Blender buffers stdout
    through a pipe, so judge progress by counting output files, not log lines.

12. **Downloads** (textures, HDRIs, models): only CC0, or with a checksum from the
    publisher, recorded in `assets/MANIFEST.md`. Get texture maps through
    `bkit.texture_set(folder, name)` — it raises naming the map it could not find,
    where a wrong name silently renders the whole scene flat grey.

13. **Before writing compositor, material, world or camera code, read
    `REFERENCE.md`** — the Blender 5.x API traps and the measured numbers (mist
    density, Glare threshold, camera `clip_end`, quad vertex order).

## Prove the skill on this machine

```text
"<blender>" -b -P <skill>/scripts/smoke.py -- --out smoke.png
```

It builds a box with `bkit`, prints the `REPORT` line and `issues=none`, and
renders a 64x64 CPU still. If that runs, `bkit` imports under `-P` and this Blender
can render headless — which is everything a first Blender chat needs to know before
it writes a real build script.
