"""Shared bpy helpers for driving Blender from scripts (Blender 5.2 LTS verified).

Every build script does:
    import os, sys; sys.path.insert(0, os.path.dirname(__file__))
    import bkit

Headless usage (never needs the GUI, never needs MCP):
    blender -b -P scripts/01_build.py -- --out scene/build.blend
"""
import math
import os

import bpy
from mathutils import Euler, Matrix, Vector

# --------------------------------------------------------------------- GPU rules
# Default policy: use every GPU Cycles finds. When this machine's cards are busy
# serving another program, say which one Blender may have: BKIT_GPU_INCLUDE
# (or BKIT_GPU_EXCLUDE) holds comma-separated substrings of the device name.


def metric(scene, fps=24):
    """Work in meters - the article's #1 rule."""
    u = scene.unit_settings
    u.system = "METRIC"
    u.length_unit = "METERS"
    u.scale_length = 1.0
    scene.render.fps = fps
    return scene


def _env_list(value, env_name):
    """A filter list from the argument, or from the environment when it is None.

    Comma-separated, blank entries dropped, empty means no filter at all.
    """
    if value is None:
        value = os.environ.get(env_name, "")
    if isinstance(value, str):
        parts = value.split(",")
    else:
        parts = [str(v) for v in value]
    return [p.strip() for p in parts if p.strip()]


def use_gpus(scene, include=None, exclude=None, device_type="OPTIX"):
    """Enable every GPU Cycles finds; filter only when asked to.

    include / exclude default to BKIT_GPU_INCLUDE / BKIT_GPU_EXCLUDE: comma
    lists of device-name substrings, matched case-insensitively (empty = no
    filter). Keeps the OPTIX -> CUDA fallback, and when nothing matches it says
    so and renders on CPU - a stated choice, printed, never silent.
    """
    prefs = bpy.context.preferences.addons.get("cycles")
    if prefs is None:
        print("bkit: no cycles addon, CPU render")
        return False
    p = prefs.preferences
    try:
        p.compute_device_type = device_type
    except Exception:
        p.compute_device_type = "CUDA"
    p.refresh_devices()
    wanted = [s.lower() for s in _env_list(include, "BKIT_GPU_INCLUDE")]
    skip = [s.lower() for s in _env_list(exclude, "BKIT_GPU_EXCLUDE")]
    enabled = []
    for d in p.devices:
        name = d.name.lower()
        d.use = not any(s in name for s in skip) and (not wanted or any(s in name for s in wanted))
        if d.use:
            enabled.append(d.name)
    scene.cycles.device = "GPU"
    print(f"bkit: cycles {p.compute_device_type} enabled={enabled}")
    if not enabled:
        scene.cycles.device = "CPU"
        print("bkit: no GPU matched, using CPU")
    return bool(enabled)


def cpu_render(scene, samples=64):
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.render.threads_mode = "AUTO"


# ------------------------------------------------------------------- mesh tools
def link(scene, collection, mesh, name):
    """Create a mesh datablock + object with an exact, collision-free name."""
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    collection.objects.link(ob)
    return ob


def box(name, size, center=(0, 0, 0), rot_z=0.0):
    """Return (verts, edges, faces) for a rectangular box in LOCAL space."""
    sx, sy, sz = (abs(v) for v in size)
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    v = [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
         (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]
    f = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 4, 7, 3), (1, 5, 6, 2), (0, 1, 5, 4), (2, 3, 7, 6)]
    return v, f


def prism(name, profile_pts, z0, z1, cap=True):
    """Vertical prism from a 2D profile between two heights. Returns (v,f).
    Ring 0 = verts 0..n-1 (z0), ring 1 = verts n..2n-1 (z1)."""
    v, f = [], []
    n = len(profile_pts)
    for z in (z0, z1):
        for x, y in profile_pts:
            v.append((x, y, z))
    for i in range(n):
        a, b = i, (i + 1) % n
        c, d = n + i, n + (i + 1) % n
        f.append((a, b, d, c))  # bottom_i, bottom_i+1, top_i+1, top_i - not a bowtie
    if cap:
        f.insert(0, tuple(range(n - 1, -1, -1)))
        f.append(tuple(range(2 * n - 1, n - 1, -1)))
    return v, f


def loft(name, sections):
    """Loft a chain of cross-sections into quads. Points are (x, y) or (x, y, z).
    sections: list of lists - all the same point count. Returns (v,f)."""
    v, f = [], []
    for sec in sections:
        for pt in sec:
            v.append((pt[0], pt[1], pt[2] if len(pt) > 2 else 0.0))
    n = len(sections[0])
    for s in range(len(sections) - 1):
        for i in range(n):
            a = s * n + i
            b = s * n + (i + 1) % n
            c = (s + 1) * n + (i + 1) % n
            d = (s + 1) * n + i
            f.append((a, b, c, d))
    return v, f


def beam(p0, p1, t=0.6, t2=None):
    """Oriented box (a girder/brace) between two world-space points.
    Returns (verts, faces) - 8 verts, 6 quads, 12 tris. Stable roll axis."""
    t2 = t if t2 is None else t2
    d = Vector(p1) - Vector(p0)
    L = d.length
    if L < 1e-9:
        return [], []
    d = d.normalized()
    axis = Vector((0, 0, 1.0)) if abs(d.z) < 0.99 else Vector((1.0, 0, 0))
    right = d.cross(axis).normalized()
    up = d.cross(right).normalized()
    r = right * (t / 2.0)
    u = up * (t2 / 2.0)
    v = []
    for p in (p0, p1):
        px, py, pz = Vector(p)
        for dx, dy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            c = px + dx * r.x + dy * u.x, py + dx * r.y + dy * u.y, pz + dx * r.z + dy * u.z
            v.append(c)
    f = [(0, 1, 2, 3), (4, 5, 6, 7),
         (0, 4, 3, 7), (1, 5, 2, 6), (0, 1, 5, 4), (2, 3, 7, 6)]
    # cap ends correctly: ring 0-3 at p0, 4-7 at p1
    f = [(0, 3, 2, 1), (4, 5, 6, 7),
         (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return v, f


def chain_beams(members):
    """Append many beams into one mesh. members: list of (p0, p1, t)."""
    verts, faces = [], []
    for p0, p1, t in members:
        v, f = beam(p0, p1, t)
        base = len(verts)
        verts.extend(v)
        faces.extend([tuple(i + base for i in q) for q in f])
    return verts, faces


def set_mesh(ob, verts, faces):
    ob.data.clear_geometry()
    ob.data.from_pydata(verts, [], faces)
    ob.data.update()


# ------------------------------------------------------------------- materials
def _in(node, *names):
    """Find a BSDF input by any of several names (Blender renames them between releases)."""
    for n in names:
        if n in node.inputs:
            return node.inputs[n]
    return None


def pbr(name, base_color, metallic=0.0, roughness=0.5, emit=0.0, emit_color=(1, 1, 1, 1)):
    """Principled BSDF with plain values - survives glTF export (article rule)."""
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    for names, val in (("Base Color", base_color), ("Metallic", metallic),
                       ("Roughness", roughness), ("Specular IOR Level|Specular", 0.5)):
        sock = _in(bsdf, *names.split("|"))
        if sock is not None:
            sock.default_value = val
    if emit:
        sock = _in(bsdf, "Emission Color", "Emission")
        if sock is not None:
            sock.default_value = emit_color
        s2 = _in(bsdf, "Emission Strength")
        if s2 is not None:
            s2.default_value = emit
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    try:
        m.blend_method = "OPAQUE"
    except Exception:
        pass
    return m


def assign(ob, mat):
    ob.data.materials.clear()
    ob.data.materials.append(mat)


# --------------------------------------------------------------- photoreal kit
# Texture-mapped PBR, world-scale UVs, alpha cards. Everything here is built so
# the SAME material survives glTF export (Godot / three.js), which means: real UVs,
# image textures only, no procedural-only shaders on exported objects.

def tex(path, srgb=True):
    """Load (or reuse) an image datablock with the right colour space."""
    key = os.path.abspath(path)
    name = os.path.basename(key)
    im = bpy.data.images.get(name)
    if im is None:
        im = bpy.data.images.load(key, check_existing=True)
        im.name = name
    for attr in ("colorspace_settings.name",):
        try:
            if attr.endswith(".name"):
                getattr(im, attr.rsplit(".", 1)[0]).name = "sRGB" if srgb else "Non-Color"
            else:
                setattr(im, attr, "sRGB" if srgb else "Non-Color")
            break
        except Exception:
            continue
    return im


def _map_node(nt, uv_sock, scale):
    """UV -> Mapping(scale) so one texture tile covers `scale` metres."""
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (scale, scale, scale)
    nt.links.new(uv_sock, mp.inputs["Vector"])
    return mp


def mat_tex(name, diff=None, rough=None, nor=None, scale=0.5, tint=(1, 1, 1),
            rough_fac=1.0, nor_str=0.5, metallic=0.0, emit=0.0,
            emit_color=(1, 1, 1, 1), alpha=None, mask=0.5, blend="OPAQUE",
            coat=0.0, transmission=0.0, sheen=0.0, leaf_glow=0.0,
            rough_default=0.6, double_sided=True):
    """UV-driven Principled BSDF from Poly Haven maps (any subset).

    scale      metres per texture tile (must match the UV pass)
    leaf_glow  >0 mixes in a Translucent BSDF so foliage lit from behind glows
    blend      OPAQUE | MASK | BLEND (MASK/BLEND need `alpha`)
    """
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "UVMap"
    mp = _map_node(nt, uv.outputs["UV"], scale)

    def img_sock(path, srgb):
        ti = nt.nodes.new("ShaderNodeTexImage")
        ti.image = tex(path, srgb=srgb)
        try:
            ti.extension = "REPEAT"
        except Exception:
            pass
        nt.links.new(mp.outputs["Vector"], ti.inputs["Vector"])
        return ti

    col_sock = b.inputs["Base Color"] if "Base Color" in b.inputs else None
    diff_ti = None
    if diff and col_sock is not None:
        ti = img_sock(diff, True)
        diff_ti = ti
        if tuple(tint) != (1, 1, 1):
            mixn = nt.nodes.new("ShaderNodeMix")
            mixn.data_type = "RGBA"
            mixn.blend_type = "MULTIPLY"
            mixn.inputs["Factor"].default_value = 1.0
            mixn.inputs["A"].default_value = (1, 1, 1, 1)
            nt.links.new(ti.outputs["Color"], mixn.inputs["B"])
            mixn.inputs["A"].default_value = (*tint, 1.0)
            nt.links.new(mixn.outputs["Result"], col_sock)
        else:
            nt.links.new(ti.outputs["Color"], col_sock)
    elif col_sock is not None:
        col_sock.default_value = (0.5, 0.5, 0.5, 1)

    rsock = b.inputs["Roughness"] if "Roughness" in b.inputs else None
    if rough and rsock is not None:
        ti = img_sock(rough, False)
        if rough_fac != 1.0:
            mul = nt.nodes.new("ShaderNodeMath")
            mul.operation = "MULTIPLY"
            mul.inputs[1].default_value = rough_fac
            nt.links.new(ti.outputs["Color"], mul.inputs[0])
            nt.links.new(mul.outputs[0], rsock)
        else:
            nt.links.new(ti.outputs["Color"], rsock)
    elif rsock is not None:
        rsock.default_value = rough_default

    if nor and "Normal" in b.inputs:
        ti = img_sock(nor, False)
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = nor_str
        nt.links.new(ti.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])

    sock = _in(b, "Metallic")
    if sock:
        sock.default_value = metallic
    alpha_src = None
    alpha_sock = _in(b, "Alpha")
    if alpha_sock is not None:
        if alpha is not None:
            at = diff_ti if alpha == diff else img_sock(alpha, True)
            if at is not None:
                nt.links.new(at.outputs["Alpha"], alpha_sock)
                alpha_src = at
        elif blend != "OPAQUE" and diff_ti is not None:
            # a PNG card that carries its own alpha channel.  Without this link
            # the quad is fully opaque and the card's transparent background
            # renders as a black slab - which is what made every tree in the
            # garden read as a fan of painted boards.
            nt.links.new(diff_ti.outputs["Alpha"], alpha_sock)
            alpha_src = diff_ti
    sock = _in(b, "Coat Weight", "Clearcoat")
    if sock:
        sock.default_value = coat
    sock = _in(b, "Transmission Weight", "Transmission")
    if sock:
        sock.default_value = transmission
    sock = _in(b, "Sheen Weight")
    if sock:
        sock.default_value = sheen
    if emit:
        c = _in(b, "Emission Color", "Emission")
        if c:
            c.default_value = emit_color
        s = _in(b, "Emission Strength")
        if s:
            s.default_value = emit

    shader_out = b.outputs["BSDF"]
    if leaf_glow > 0.0:
        try:
            tr = nt.nodes.new("ShaderNodeBsdfTranslucent")
            # glow in the leaf's own colour: a fixed green here turned the whole
            # cherry canopy green whenever a card was seen at an angle
            if diff_ti is not None:
                nt.links.new(diff_ti.outputs["Color"], tr.inputs["Color"])
            else:
                tr.inputs["Color"].default_value = (0.52, 0.70, 0.30, 1)
            lw = nt.nodes.new("ShaderNodeLayerWeight")
            lw.inputs["Blend"].default_value = 0.35
            mix = nt.nodes.new("ShaderNodeMixShader")
            nt.links.new(lw.outputs["Facing"], mix.inputs["Fac"])
            nt.links.new(b.outputs["BSDF"], mix.inputs[1])
            nt.links.new(tr.outputs["BSDF"], mix.inputs[2])
            f = nt.nodes.new("ShaderNodeMath")
            f.operation = "MULTIPLY_ADD"
            f.inputs[1].default_value = leaf_glow
            f.inputs[2].default_value = 0.0
            nt.links.new(lw.outputs["Facing"], f.inputs[0])
            nt.links.new(f.outputs[0], mix.inputs["Fac"])
            nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
            shader_out = mix.outputs["Shader"]
        except Exception as e:
            print("bkit: leaf_glow skipped", e)

    if blend != "OPAQUE" and alpha_src is not None:
        # The cutout has to live in the nodes: blend_method is an EEVEE-only
        # setting, Cycles ignores it, and the alpha linked into the Principled
        # above does nothing there.  Without this mix every hole in every card
        # renders as the PNG's black background and the trees read as a fan of
        # painted boards.  It is a real transparent closure, so a deep canopy
        # also needs transparent_max_bounces raised.
        try:
            trs = nt.nodes.new("ShaderNodeBsdfTransparent")
            trs.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
            amix = nt.nodes.new("ShaderNodeMixShader")
            nt.links.new(alpha_src.outputs["Alpha"], amix.inputs["Fac"])
            nt.links.new(trs.outputs["BSDF"], amix.inputs[1])
            nt.links.new(shader_out, amix.inputs[2])
            nt.links.new(amix.outputs["Shader"], out.inputs["Surface"])
        except Exception as e:
            print("bkit: alpha mix skipped", e)

    try:
        m.alpha_threshold = mask
    except Exception:
        pass
    want = {"MASK": "HASHED", "BLEND": "BLEND", "HASHED": "HASHED",
            "OPAQUE": "OPAQUE"}.get(blend, blend)
    for cand in (want, "HASHED", "CLIPPED", "MASK", blend):
        try:
            m.blend_method = cand
            break
        except Exception:
            continue
    else:
        print("bkit: could not set blend_method", blend, "on", name)
    try:
        m.use_backface_culling = not double_sided
        m.show_transparent_back = False
    except Exception:
        pass
    return m


# Poly Haven / ambientCG spell the same map several ways; every name a set may
# arrive under, most common first.
_TEX_CHANNEL = {"diff": ("diff", "diffuse"),
                "rough": ("rough", "roughness"),
                "nor": ("nor_gl", "nor", "normal_gl", "normal")}
_TEX_RES = ("2k", "4k", "8k", "1k", "16k")
_TEX_EXT = ("jpg", "png", "tga", "exr")


def texture_set(folder, name):
    """Paths for one texture set as (diff, rough, nor) - mappair, but loud.

    Looks in `folder` for the usual Poly Haven file names (`name_diff_2k.jpg`,
    `name_nor_gl_2k.jpg`, `name_rough_2k.jpg`, and their other resolutions,
    extensions and spellings). The diffuse map is required; roughness and
    normal are optional and come back None, printed.

    A material name is not an asset set name: `mappair("timber")` returned three
    Nones and `mat_tex` quietly fell back to flat grey, which rendered an entire
    scene white. This raises and names the set and the maps it looked for.
    """
    found = {}
    for key, channels in _TEX_CHANNEL.items():
        hit = None
        for res in _TEX_RES:
            for ext in _TEX_EXT:
                for channel in channels:
                    cand = os.path.join(folder, f"{name}_{channel}_{res}.{ext}")
                    if os.path.exists(cand):
                        hit = cand
                        break
                if hit:
                    break
            if hit:
                break
        found[key] = hit
        if not hit:
            print(f"bkit: texture set {name!r} has no {key} map in {folder}")
    if not found["diff"]:
        looked = ", ".join(f"{name}_{c}_{r}.jpg"
                           for c in _TEX_CHANNEL["diff"] for r in _TEX_RES)
        raise FileNotFoundError(
            f"bkit: texture set {name!r} needs a diffuse map; looked in {folder} "
            f"for {looked} (and the other resolutions/extensions). "
            "Pass the CC0 asset set's own file name, not a material name.")
    return found["diff"], found["rough"], found["nor"]


def uv_cube(objs, cube_size=1.0):
    """World-scale UVs: cube project with a fixed cube size so every object in
    the scene shares one texel density, and glTF gets real UVs."""
    done = 0
    for ob in objs:
        if ob.type != "MESH" or not ob.data.polygons:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        try:
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.cube_project(cube_size=cube_size, correct_aspect=True,
                                    scale_to_bounds=False)
            bpy.ops.object.mode_set(mode="OBJECT")
            done += 1
        except Exception as e:
            bpy.ops.object.mode_set(mode="OBJECT")
            print(f"bkit: uv_cube failed on {ob.name}: {e}")
    print(f"bkit: uv_cube cube_size={cube_size} on {done} meshes")
    return done


def uv_cylinder(objs, axis="Z"):
    """Cylindrical UVs - for bamboo culms, so stripes run up the trunk."""
    done = 0
    for ob in objs:
        if ob.type != "MESH":
            continue
        bpy.ops.object.select_all(action="DESELECT")
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        try:
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.cylinder_project(direction="ALIGN_TO_OBJECT", align="FLAT_TO_OBJECT",
                                        scale_to_bounds=False)
            bpy.ops.object.mode_set(mode="OBJECT")
            done += 1
        except Exception as e:
            bpy.ops.object.mode_set(mode="OBJECT")
            print(f"bkit: uv_cylinder failed on {ob.name}: {e}")
    print(f"bkit: uv_cylinder on {done} meshes")
    return done


# ---------------------------------------------------------------- card geometry
def card_verts(w, h, pivot="center"):
    """A quad in the XY plane (normal +Z). pivot: center | bottom | hinge."""
    dy = 0.0 if pivot == "center" else -h / 2.0
    v = [(-w / 2, dy, 0.0), (w / 2, dy, 0.0), (w / 2, dy + h, 0.0), (-w / 2, dy + h, 0.0)]
    return v, [(0, 1, 2, 3)]


def add_cards(bag, w, h, tris):
    """Append many cards: tris = list of (center_xyz, euler_xyz). UVs are 0..1."""
    base = len(bag.verts)
    for (cx, cy, cz), rot in tris:
        vs, fs = card_verts(w, h)
        m = Matrix.LocRotScale(Vector((cx, cy, cz)), Euler(rot), None)
        for p in vs:
            q = m @ Vector(p)
            bag.verts.append((q.x, q.y, q.z))
        for f in fs:
            bag.faces.append(tuple(i + base for i in f))
    return len(tris)


def uv_quads(me):
    """Give a bag of quads full 0..1 UVs - each quad shows one whole card."""
    uv = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    pat = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    for i in range(len(me.loops)):
        uv.data[i].uv = pat[i % 4]
    return me


# ------------------------------------------------------------------- reporting
def tri_count(ob):
    if ob.type != "MESH":
        return 0
    return sum(len(p.poly_triangles) if hasattr(p, "poly_triangles") else max(0, len(p.vertices) - 2)
               for p in ob.data.polygons)


def report(objects, label=""):
    """The article's 'check' step: real numbers, not claims."""
    tot_tris = 0
    mins = [1e9] * 3
    maxs = [-1e9] * 3
    bad = []
    for ob in objects:
        if ob.type != "MESH":
            continue
        tot_tris += tri_count(ob)
        for c in ob.data.vertices:
            w = ob.matrix_world @ c.co
            for i in range(3):
                if w[i] < mins[i]:
                    mins[i] = w[i]
                if w[i] > maxs[i]:
                    maxs[i] = w[i]
        if tuple(round(v, 6) for v in ob.scale) != (1.0, 1.0, 1.0):
            bad.append(f"{ob.name}: unapplied scale")
        if any(v < 0 for v in ob.dimensions):
            bad.append(f"{ob.name}: negative dims")
        for f in ob.data.polygons:
            if f.area > 1e4:
                bad.append(f"{ob.name}: huge face area {f.area:.0f}")
                break
        loose = sum(1 for e in ob.data.edges if e.is_loose)
        if loose:
            bad.append(f"{ob.name}: {loose} loose edges")
        degen = sum(1 for p in ob.data.polygons if p.area < 1e-7)
        if degen:
            bad.append(f"{ob.name}: {degen} zero-area faces")
    print(f"REPORT {label}: meshes={len([o for o in objects if o.type=='MESH'])} "
          f"tris={tot_tris} verts={sum(len(o.data.vertices) for o in objects if o.type=='MESH')}")
    print(f"  bounds min={tuple(round(v,3) for v in mins)} max={tuple(round(v,3) for v in maxs)}")
    print(f"  size={tuple(round(maxs[i]-mins[i],3) for i in range(3))}")
    print(f"  issues={bad if bad else 'none'}")
    return {"tris": tot_tris, "bounds_min": mins, "bounds_max": maxs, "issues": bad}


def clean_names(scene):
    """No Cube.017 in the export set - article rule."""
    fixed = 0
    for coll in (bpy.data.objects, bpy.data.materials, bpy.data.meshes):
        for d in list(coll):
            base = d.name.rsplit(".", 1)[0]
            if base != d.name:
                if base not in [x.name for x in coll if x is not d]:
                    d.name = base
                    fixed += 1
    print(f"bkit: renamed {fixed} suffixed datablocks")
    return fixed


def orphan_purge():
    before = (len(bpy.data.meshes), len(bpy.data.materials), len(bpy.data.lights))
    try:
        bpy.ops.outliner.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
    except Exception as e:
        print("bkit: orphans_purge skipped:", e)
        return
    print(f"bkit: purge {before} -> "
          f"({len(bpy.data.meshes)}, {len(bpy.data.materials)}, {len(bpy.data.lights)})")


# -------------------------------------------------------------------- export
def export_glb(filepath, objects, authoring="+Y up"):
    """GLB, selection only, Y-up for Godot/three.js. Then read it back."""
    os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
    prev = bpy.context.view_layer.objects.active
    bpy.ops.object.select_all(action="DESELECT")
    for ob in objects:
        try:
            ob.select_set(ob.name in bpy.context.view_layer.objects)
        except Exception:
            pass
    if objects:
        bpy.context.view_layer.objects.active = objects[0]
    kwargs = dict(filepath=filepath, export_format="GLB", use_selection=True,
                  export_apply=True, export_materials="EXPORT",
                  export_animations=False, export_extras=True)
    ops = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    for nice, want in (("uv", ("export_uv", "export_uvs")),
                       ("normals", ("export_normals",)),
                       ("texcoords", ("export_texcoords", "export_uvs"))):
        for k in want:
            if k in ops:
                kwargs[k] = True
                break
        else:
            print(f"bkit: exporter has no {nice} flag - skipped")
    try:
        bpy.ops.export_scene.gltf(**kwargs, export_yup=True)
    except TypeError as e:
        print("bkit: gltf flag rejected, retrying:", e)
        kwargs.pop("export_yup", None)
        bpy.ops.export_scene.gltf(**kwargs)
    bpy.ops.object.select_all(action="DESELECT")
    if prev:
        try:
            prev.select_set(True)
        except Exception:
            pass
    print(f"bkit: wrote {filepath} ({os.path.getsize(filepath)/1024:.1f} KB) selection={len(objects)}")
    return filepath


# The read-back runs in its own Blender, so it is a script string, not a file:
# a helper folder that ships one file cannot lose half of a two-file check.
_REIMPORT_PROBE = '''
import os
import sys

import bpy

path = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else None
if not path or not os.path.exists(path):
    print("REIMPORT FAIL: no file", path)
    sys.exit(1)

bpy.ops.wm.read_factory_settings(use_empty=True)
if path.lower().endswith(".glb") or path.lower().endswith(".gltf"):
    bpy.ops.import_scene.gltf(filepath=path)
else:
    bpy.ops.import_scene.fbx(filepath=path)

tris = 0
mins = [1e9] * 3
maxs = [-1e9] * 3
names = []
for ob in bpy.context.view_layer.objects:
    names.append(f"{ob.name} ({ob.type})")
    if ob.type != "MESH":
        continue
    tris += sum(max(0, len(p.vertices) - 2) for p in ob.data.polygons)
    for v in ob.data.vertices:
        w = ob.matrix_world @ v.co
        for i in range(3):
            mins[i] = min(mins[i], w[i])
            maxs[i] = max(maxs[i], w[i])

print("REIMPORT OK:", os.path.basename(path))
print(f"  objects={len(bpy.context.view_layer.objects)} tris={tris} "
      f"materials={len(bpy.data.materials)} images={len(bpy.data.images)}")
print(f"  bounds={tuple(round(maxs[i]-mins[i],3) for i in range(3))} m "
      f"(min {tuple(round(v,3) for v in mins)})")
bad = [n for n in names if any(s in n for s in (".001", ".002", "Cube"))]
print(f"  name_pollution={bad if bad else 'none'}")
print(f"  names={names}")
'''


def reimport_check(filepath, label=""):
    """Verify the file the engine will read - not just the file I wrote.

    Runs `_REIMPORT_PROBE` in a second headless Blender and echoes its lines.
    """
    import subprocess
    import tempfile

    fd, probe = tempfile.mkstemp(prefix="bkit_reimport_", suffix=".py")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(_REIMPORT_PROBE)
        r = subprocess.run([bpy.app.binary_path, "-b", "-P", probe, "--", filepath],
                           capture_output=True, text=True)
    finally:
        try:
            os.unlink(probe)
        except OSError:
            pass
    out = (r.stdout or "") + (r.stderr or "")
    for line in out.splitlines():
        if line.startswith(("REIMPORT", "  ")):
            print(f"  [{label}] {line.strip()}")
    return r.returncode == 0


# -------------------------------------------------------------------- rendering
def set_world_look(scene, which="dusk", strength=0.55, z_rot=0.0):
    """Pick one of the HDRI backgrounds 06_realism.py built ('dusk'/'day'),
    or 'none' to fall back to the procedural sky. Missing nodes are not an error."""
    w = scene.world
    if not (w and w.use_nodes):
        return
    nt = w.node_tree
    hit = False
    for n in nt.nodes:
        if n.type == "BACKGROUND":
            want = (which != "none" and n.name == f"HDRI_{which}")
            n.inputs["Strength"].default_value = strength if want else 0.0
            n.mute = (which == "none")
            if want:
                hit = True
                link = n.inputs["Color"].links
                if link and link[0].from_node.type == "TEX_ENVIRONMENT":
                    env = link[0].from_node
                    ml = env.inputs["Vector"].links
                    if ml:
                        ml[0].from_node.inputs["Rotation"].default_value = \
                            (0.0, 0.0, math.radians(z_rot))
        if n.type == "TEX_SKY":
            n.mute = (which != "none" and hit)
    if which != "none" and not hit:
        print("bkit: no HDRI background found - set_world_look ignored")


def scene_path(root, argv_name="--scene", default=None):
    """Which .blend to load: --scene <name or absolute path>. No default on purpose:
    guessing a scene file means rendering someone else's scene. A missing --scene
    raises SystemExit naming the flag."""
    import sys

    arg = default
    if "--scene" in sys.argv:
        i = sys.argv.index("--scene")
        if i + 1 < len(sys.argv):
            arg = sys.argv[i + 1]
    if not arg:
        raise SystemExit("bkit: pass --scene <file.blend>")
    p = arg if os.path.isabs(arg) else os.path.join(root, "scene", arg)
    print(f"bkit: scene = {p}")
    return p


def render_dir(folder):
    """One folder per render, per the user's rule."""
    os.makedirs(folder, exist_ok=True)
    return folder


def still(filepath, engine="BLENDER_EEVEE", res=(1920, 1080), samples=64, file_format="PNG"):
    sc = bpy.context.scene
    sc.render.engine = engine
    if engine == "CYCLES":
        use_gpus(sc)
        sc.cycles.samples = samples
        sc.cycles.use_denoising = True
    elif engine == "BLENDER_EEVEE":
        try:
            sc.eevee.taa_render_samples = max(16, samples // 2)
        except Exception:
            pass
        try:
            sc.eevee.feature_set = "DEFAULT"
        except Exception:
            pass
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = file_format
    sc.render.filepath = filepath
    bpy.ops.render.render(write_still=True)
    print(f"bkit: rendered {filepath}")
    return filepath
