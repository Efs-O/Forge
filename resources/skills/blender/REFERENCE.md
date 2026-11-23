# Blender 5.x traps, verified on 5.2

Read this before writing compositor, material, world or camera code. Every item is
a bug someone already paid for: the API that moved, the failure that is silent, and
the number that was measured rather than guessed.

## API that moved or never existed

- `bpy.utils.engine_types` is gone — read
  `bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items`.
- Cycles prefs have no `device_types`: use `get_device_types(context)`,
  `get_devices_for_type()`, `refresh_devices()`, then set `device.use` per device.
  There is no `scene.cycles.device_type` (the device is `scene.cycles.device`).
- `bpy.types.ViewSettings` does not exist — just try the view-transform names in
  order and keep the one that lands.
- The glTF exporter has **no `export_uv` flag**. Filter kwargs against
  `bpy.ops.export_scene.gltf.get_rna_type().properties` instead of guessing
  (`bkit.export_glb` does this).
- The compositor has **no `CompositorNodeComposite`**: the output node is the
  node-group output.
- `SceneDisplay` has no `.display`; viewport shading is not settable the 4.x way.
- Sky node (`ShaderNodeTexSky`) types are `SINGLE_SCATTERING`,
  `MULTIPLE_SCATTERING`, `PREETHAM`, `HOSEK_WILKIE`, and its knobs are
  `sun_elevation`, `sun_rotation`, `sun_intensity`, `turbidity`, `air_density` —
  there is no `altitude_turbidity`.
- `node.bl_idname` is the full `ShaderNodeBsdfPrincipled`; the short
  `BSDF_PRINCIPLED` is `node.type`. Comparing `bl_idname` against the short form
  matches nothing and fails silently.

## Silent geometry bugs

- A quad whose vertex order is bottom-left, bottom-right, top-left, top-right is a
  **bowtie** and reports area 0. Correct order: bottom-left, bottom-right,
  top-right, top-left.
- Off-by-one cap indices produce faces referencing a vertex index one past the end.
  `from_pydata` accepts them; the area check catches them.
- Always print `issues=` from a real measurement, never "looks fine".

## Camera

- `clip_end` defaults to **1000 m**. A 325 m tower shot from 1 km away rendered as a
  thumbnail and looked like a broken model. Set `clip_end >= 6000` on every camera.

## Console code page

- On a console whose code page is not UTF-8 (for example Greek cp1253), a Python CLI
  that prints a Unicode arrow dies with `UnicodeEncodeError`; set
  `PYTHONIOENCODING=utf-8 PYTHONUTF8=1`.

## Lighting, not geometry, caused the worst renders

- A dark-brown material rendered as pale cream because a full-strength procedural
  sky blew out the exposure. Fix per look: dim the world Background strength, lower
  `view_settings.exposure`, and only then touch the material. And check that
  materials are actually assigned before blaming the shader.

## The look step is not decoration

- It caught four real defects (needle-thin taper, undersized arches, clipped camera,
  washed-out colour) that every numeric check had passed.

## Solve, do not eyeball

- The arches are a semicircle whose diameter is the gap between the two legs' inner
  faces, solved so the crown lands on the first platform. Record which numbers are
  measured and which are derived, in the script or in notes, before the next chat
  has to guess.

## Compositor (Blender 5.2)

- The compositor is **node-group based, and a fresh group has an empty interface**.
  `bpy.data.node_groups.new(x, "CompositorNodeTree")` then linking
  `RLayers -> ... -> NodeGroupOutput` is silently ignored until you declare the
  socket: `grp.interface.new_socket("Image", in_out="OUTPUT",
  socket_type="NodeSocketColor")`, plus `scene.render.use_compositing = True` and
  `scene.compositing_node_group = grp`. Prove it runs by rendering one shot with
  HueSat saturation 0 — the frame must grey out.
- `Type` on Glare and ColorBalance are **MENU sockets**: they take display strings
  (`"Fog Glow"`, `"Lift/Gamma/Gain"`); enum identifiers raise `TypeError`.
- Glare's `Highlights Threshold` works on the **display-referred** image, so 1.5 is
  above the range and glows nothing — use **~0.7**.
- ColorBalance's `Color Lift/Gamma/Gain` wheels **crush** this build (median 0.004
  against 0.645 ungraded); `Base Lift/Gamma/Gain` are plain float scalars, not
  colours. Do a teal-shadow / warm-highlight split with `CompositorNodeCurveRGB`
  per-channel curves instead.
- Curve nodes keep their mapping in `node.mapping`, not `node.curve_mapping`, and
  their points cannot be deleted (`points.remove(...)` →
  `Error: Unable to remove curve point`). Set the existing points' `location`, add
  the extra ones, and pin `handle_left_type = handle_right_type = "VECTOR"` so
  nothing overshoots.

## Materials and textures

- **A material name is not an asset name.** Asking for a texture set by the name you
  gave the material returns no maps, and the texture-mapped material quietly falls
  back to flat grey 0.5 — which once rendered an entire scene white. Go through
  `bkit.texture_set`, which raises and names the missing map; pass the CC0 set's own
  file name and check the files exist before blaming lighting.
- **Volume scatter density is per metre.** Along a 40-100 m view through a shallow
  mist layer, 0.012-0.067 /m washes the entire frame white;
  **~0.0016-0.0042 /m** reads as mist.
- **A saved .blend can have an empty world** (a render script that never rebuilt it
  renders sun-only and looks black). Rebuild sky + Background strength in the render
  script rather than trusting the file.
- **Alpha cards:** `blend_method` is an EEVEE-only setting — Cycles ignores it, and
  the alpha linked into the Principled BSDF does nothing there. Mix a transparent
  closure with the card's own alpha, or every hole in every card renders as the
  image's black background. A deep canopy also needs
  `cycles.transparent_max_bounces` raised, or the shadows go hard.

## Grade by numbers, not thumbnails

- Print `mean / p50 / p95 / clip>0.995` from the render's own pixels after each
  variant (`scripts/image_stats.py` does it inside Blender). A 480p thumbnail sent
  back through the chat lies about contrast, and this is what caught the Glare
  threshold and the ColorBalance crush above.

## `Scene.ray_cast`

- `Scene.ray_cast(context, depsgraph, origin, direction)` ended the script silently
  in one build here (no traceback, no print) — verify before relying on it for
  shadow tests.

## Composition that reads

What makes a hero frame of a tall subject work, in the order it hits the eye:

1. **Ground-level camera looking up.** The lens at a person's eye height makes the
   subject monumental; almost every first attempt is aerial and reads as a model.
2. **Natural framing.** A dark silhouette on one edge and a large tree on the other
   build a portal around the subject; a low wall and a path run across the bottom of
   the frame.
3. **A snow mountain directly behind the subject** — the single biggest depth and
   scale cue, and the reason the frame feels epic rather than tidy.
4. **Layered aerial perspective.** Foreground dark and saturated, midground clear,
   background washed pale blue, plus mist sitting in the ground plane.
5. **Backlight with the sun off-frame.** The subject mostly in shadow against a
   bright sky — silhouette-forward lighting, not flat front light.
6. **Bunting strung from the eaves across the sky:** a diagonal line, and a lot of
   character for very little geometry.
7. **Birds in the sky** — scale and life.
8. **A field of flowers** mid-frame, for a complementary purple-against-gold.
9. **Small warm lights** glowing under the eaves.
10. **Grade:** teal shadows, warm highlights, desaturated, filmic.

Cheapest wins when a frame falls flat, in order: a low framed camera, then the
grade, then a distant mountain ring, then bunting, then birds, then a flower field,
then ground mist. All of them are placement and shading, not new modelling.
