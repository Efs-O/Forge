"""The skill's own live check. Runs INSIDE Blender, on the CPU.

    blender -b -P smoke.py -- --out smoke.png

It builds a box with bkit, prints bkit's report lines (``REPORT ... `` and
``issues=none``), and renders a 64x64 Cycles still to ``--out``. If this runs on
a machine, then the helper file imports under ``-P``, its reporting works, and
this Blender can render headless - which is what a first Blender chat needs to
know before it writes a real build script.

Nothing here needs a scene file, a GPU or a network.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import bkit  # noqa: E402


def arg(name, default=None):
    """Read `--name value` from the arguments after Blender's `--`."""
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    for i, item in enumerate(argv):
        if item == name and i + 1 < len(argv):
            return argv[i + 1]
        if item.startswith(name + "="):
            return item[len(name) + 1:]
    return default


def main():
    out = os.path.abspath(arg("--out", "blender-skill-smoke.png"))
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bkit.metric(bpy.context.scene)

    verts, faces = bkit.box("smoke", (2.0, 2.0, 2.0))
    box = bkit.link(sc, sc.collection, None, "smoke_box")
    bkit.set_mesh(box, verts, faces)

    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 3.0
    sun_data = bpy.data.objects.new("Sun", sun)
    sc.collection.objects.link(sun_data)
    sun_data.rotation_euler = (math.radians(45), 0.0, math.radians(30))

    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    sc.world = world
    nt = world.node_tree
    if nt is None:  # 5.2 already has one; `use_nodes` is going away in 6.0
        world.use_nodes = True
        nt = world.node_tree
    bg = nt.nodes.get("Background") or nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (0.35, 0.45, 0.60, 1.0)
    bg.inputs["Strength"].default_value = 0.6
    world_out = nt.nodes.get("Output World") or nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(bg.outputs["Background"], world_out.inputs["Surface"])

    cam = bpy.data.cameras.new("Camera")
    cam.clip_start = 0.1
    cam.clip_end = 6000.0
    cam_ob = bpy.data.objects.new("Camera", cam)
    sc.collection.objects.link(cam_ob)
    cam_ob.location = (5.0, -6.0, 3.0)
    look_at = Vector((0.0, 0.0, 0.0)) - Vector(cam_ob.location)
    cam_ob.rotation_euler = look_at.normalized().to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam_ob

    bpy.context.view_layer.update()
    bkit.report([box], "blender-skill smoke")

    sc.render.engine = "CYCLES"
    bkit.cpu_render(sc, samples=8)
    sc.render.resolution_x = 64
    sc.render.resolution_y = 64
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)

    made = os.path.exists(out)
    print(f"SMOKE out={out} exists={made} "
          f"bytes={os.path.getsize(out) if made else 0} device={sc.cycles.device}")
    return 0 if made else 1


if __name__ == "__main__":
    sys.exit(main())
