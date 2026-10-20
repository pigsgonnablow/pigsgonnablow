"""Builds the game's other models (dragon, burger, coin, rocks, flowers) in Blender and
renders them to one sprite sheet.

Run with the Blender Python module (pip install bpy pillow):
    python blender/make_props.py

Writes:
    blender/props.blend  every model, one scene per prop, open it in Blender to tweak
    props.png            sprite sheet used by index.html: one 256px frame per prop, in PROPS
                         order. Each model is framed to fill the same share of its frame
                         (FILL), centred, so the game can draw any of them at a given size the
                         same way.
"""
import math
import os
import random
import tempfile

import bpy
import bmesh
from mathutils import Vector
from PIL import Image

from make_pig import HERE, ROOT, material, smooth, sphere, cylinder

FRAME = 256
FILL = 0.9  # the model's larger side spans this share of the frame
# Frame order in props.png; index.html's PROP_FRAMES must match.
PROPS = ['dragon', 'burger', 'coin', 'rock0', 'rock1', 'rock2', 'daisy', 'blossom', 'tulip']


def cone(name, loc, r1, r2, depth, rot, mat, scale=(1, 1, 1), verts=24, sub=1):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=depth,
                                    location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    o.data.materials.append(mat)
    if sub:
        smooth(o, sub)
    return o


def flat_shape(name, points, thickness, loc, rot, mat, sub=2):
    """A flat polygon (points in its local XY plane) given some thickness, then smoothed."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    verts = [bm.verts.new((x, y, 0)) for x, y in points]
    face = bm.faces.new(verts)
    bmesh.ops.extrude_face_region(bm, geom=[face])
    for v in bm.verts:
        if v.co.z == 0 and v not in verts:
            v.co.z = thickness
    bm.normal_update()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    o = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = rot
    o.data.materials.append(mat)
    smooth(o, sub)
    return o


# ---------- models ----------
# Each builder makes its model around the origin and returns the camera direction it is seen
# from: (azimuth, elevation) in degrees, azimuth 0 = camera on -Y looking toward +Y.

def build_dragon():
    green = material('DragonSkin', '#4caf50', rough=0.45, sss=0.05)
    belly = material('DragonBelly', '#c8e27a', rough=0.5)
    wing = material('DragonWing', '#2e8b57', rough=0.5)
    horn = material('DragonHorn', '#f3e3b5', rough=0.4)
    dark = material('Dark', '#1e2a1e', rough=0.3)
    white = material('Shine', '#ffffff', rough=0.2)

    # Side view with the head pointing -X, which the camera sees as screen-left, like the 🐉
    # emoji it replaces (the game mirrors it to face right).
    sphere('Body', (0.15, 0, 0), (0.85, 0.5, 0.48), green)
    sphere('Belly', (0.12, -0.12, -0.12), (0.72, 0.4, 0.34), belly)
    sphere('Neck', (-0.6, 0, 0.35), (0.32, 0.3, 0.42), green)
    sphere('Head', (-0.95, 0, 0.75), (0.5, 0.42, 0.42), green)
    sphere('Snout', (-1.36, 0, 0.62), (0.34, 0.3, 0.25), green)
    for s in (-1, 1):
        sphere(f'Nostril.{s}', (-1.66, 0.1 * s, 0.7), (0.035, 0.035, 0.03), dark, 12)
        sphere(f'Eye.{s}', (-1.06, 0.33 * s, 0.9), (0.1, 0.06, 0.13), dark, 20)
        sphere(f'EyeShine.{s}', (-1.1, 0.38 * s, 0.95), (0.035, 0.02, 0.035), white, 12)
        cone(f'Horn.{s}', (-0.78, 0.18 * s, 1.18), 0.09, 0.01, 0.38,
             (math.radians(-12 * s), math.radians(30), 0), horn)
        for lx in (-0.35, 0.6):
            cylinder(f'Leg.{s}.{lx}', (lx, 0.25 * s, -0.48), 0.12, 0.34, (0, 0, 0), green, 0.04)
            sphere(f'Foot.{s}.{lx}', (lx - 0.06, 0.25 * s, -0.66), (0.16, 0.12, 0.07), green, 16)
    # wings, raised over the back
    for s, tint in ((-1, wing), (1, wing)):
        flat_shape(f'Wing.{s}', [(x * 1.6, y * 1.6) for x, y in
                                 [(0, 0), (0.55, 0.05), (0.95, 0.75), (0.55, 0.45), (0.35, 0.8),
                                  (0.15, 0.4), (-0.1, 0.65)]], 0.05,
                   (-0.2, 0.12 * s, 0.4), (math.radians(90 - 20 * s), 0, math.radians(-10)), tint)
    # tail: a tapering chain of spheres curling up at the end
    for i in range(10):
        t = i / 9
        r = 0.3 * (1 - t) + 0.08
        sphere(f'Tail.{i}', (0.85 + t * 1.0, 0, -0.05 + t * t * 0.55), (r * 1.3, r, r), green, 16)
    # spade-shaped tail tip, flat in the XZ plane so it reads in profile
    flat_shape('TailTip', [(0, 0), (0.22, 0.12), (0.12, 0.38), (0, 0.24), (-0.12, 0.38),
                           (-0.22, 0.12)], 0.05, (1.86, 0.025, 0.5),
               (math.radians(90), math.radians(35), 0), wing, sub=1)
    # back spikes
    for i, x in enumerate((-0.45, -0.15, 0.15, 0.45, 0.75)):
        cone(f'Spike.{i}', (x, 0, 0.56 - 0.06 * abs(x - 0.15)), 0.11, 0.0, 0.26, (0, 0, 0), horn,
             scale=(1, 0.5, 1), verts=4)
    return 0, 8


def build_burger():
    bun = material('Bun', '#e0a04a', rough=0.55)
    bun_base = material('BunBase', '#d38e3a', rough=0.6)
    patty = material('Patty', '#5b3320', rough=0.85)
    cheese = material('Cheese', '#ffc928', rough=0.4)
    lettuce = material('Lettuce', '#6cc04a', rough=0.6)
    tomato = material('Tomato', '#e5402f', rough=0.35)
    seed = material('Seed', '#fff4d6', rough=0.5)

    cylinder('BunBottom', (0, 0, -0.42), 1.0, 0.3, (0, 0, 0), bun_base, 0.12)
    cylinder('Patty', (0, 0, -0.17), 1.04, 0.26, (0, 0, 0), patty, 0.1)
    c = cylinder('Cheese', (0, 0, -0.02), 0.95, 0.06, (0, 0, math.radians(45)), cheese, 0.02)
    c.data.polygons.foreach_set('use_smooth', [False] * len(c.data.polygons))
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -0.02), rotation=(0, 0, math.radians(20)))
    sl = bpy.context.object
    sl.name = 'CheeseSlice'
    sl.scale = (1.6, 1.6, 0.05)
    sl.data.materials.append(cheese)
    cylinder('Tomato', (0, 0, 0.06), 0.98, 0.1, (0, 0, 0), tomato, 0.04)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.98, minor_radius=0.08, location=(0, 0, 0.14),
                                     major_segments=48, minor_segments=12)
    lt = bpy.context.object
    lt.name = 'Lettuce'
    for v in lt.data.vertices:  # ruffle the edge
        a = math.atan2(v.co.y, v.co.x)
        v.co.z += 0.05 * math.sin(a * 11)
    lt.data.materials.append(lettuce)
    smooth(lt, 1)
    top = sphere('BunTop', (0, 0, 0.18), (1.02, 1.02, 0.62), bun)
    # cut away the bottom half of the top bun sphere
    bm = bmesh.new()
    bm.from_mesh(top.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -0.05], context='VERTS')
    bm.to_mesh(top.data)
    bm.free()
    rnd = random.Random(3)
    for i in range(16):
        a = rnd.uniform(0, math.tau)
        r = rnd.uniform(0.15, 0.8)
        z = 0.18 + 0.62 * math.sqrt(max(0.0, 1 - r * r)) + 0.01
        o = sphere(f'Seed.{i}', (r * math.cos(a), r * math.sin(a), z), (0.07, 0.035, 0.03), seed, 10)
        o.rotation_euler = (0, 0, a + rnd.uniform(-0.6, 0.6))
    return 0, 22


def build_coin():
    gold = material('Gold', '#f5c542', rough=0.25)
    gold.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 1.0
    gold_dark = material('GoldDark', '#d9a21b', rough=0.3)
    gold_dark.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 1.0
    # Face-on to the camera: the coin is a disc standing up in the XZ plane.
    cylinder('Coin', (0, 0, 0), 1.0, 0.2, (math.radians(90), 0, 0), gold_dark, 0.06)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.86, minor_radius=0.07, location=(0, -0.1, 0),
                                     rotation=(math.radians(90), 0, 0))
    rim = bpy.context.object
    rim.name = 'Rim'
    rim.data.materials.append(gold)
    pts = []
    for i in range(10):
        a = math.pi / 2 + i * math.pi / 5
        r = 0.55 if i % 2 == 0 else 0.23
        pts.append((r * math.cos(a), r * math.sin(a)))
    star = material('StarGold', '#ffe27a', rough=0.15)
    star.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 1.0
    flat_shape('Star', pts, 0.1, (0, -0.1, 0), (math.radians(90), 0, 0), star, sub=0)
    return 12, 10


def build_rock(seed_value):
    grey = material('Rock', '#8a8f98', rough=0.8)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1.0)
    o = bpy.context.object
    o.name = 'Rock'
    rnd = random.Random(seed_value)
    bumps = [(Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.3, 1))).normalized(),
              rnd.uniform(0.1, 0.25)) for _ in range(6)]
    for v in o.data.vertices:
        n = v.co.normalized()
        v.co *= 1 + sum(h * max(0.0, n.dot(d)) ** 3 for d, h in bumps) - 0.18 * rnd.random()
        if v.co.z < -0.1:
            v.co.z = -0.1 + (v.co.z + 0.1) * 0.15  # flat-ish base sitting on the ground
    o.scale = (1.0 + 0.2 * rnd.random(), 0.8 + 0.2 * rnd.random(), 0.55)
    o.data.materials.append(grey)
    smooth(o, 0)
    return 0, 35


def petal_flower(petal_color, centre_color, petals, petal_len, petal_w):
    petal = material('Petal', petal_color, rough=0.5, sss=0.1)
    centre = material('Centre', centre_color, rough=0.6)
    leaf = material('Leaf', '#4f9e3a', rough=0.6)
    for i in range(petals):
        a = i * math.tau / petals
        o = sphere(f'Petal.{i}', (math.cos(a) * petal_len * 0.6, math.sin(a) * petal_len * 0.6, 0),
                   (petal_len * 0.62, petal_w, 0.06), petal, 16)
        o.rotation_euler = (0, math.radians(-12), a)
    sphere('Centre', (0, 0, 0.06), (0.24, 0.24, 0.12), centre, 20)
    for i, a in enumerate((0.4, 3.0)):
        o = sphere(f'Leaf.{i}', (math.cos(a) * 0.95, math.sin(a) * 0.95, -0.1), (0.45, 0.18, 0.04), leaf, 16)
        o.rotation_euler = (0, 0, a)
    return 0, 50


def build_daisy():
    return petal_flower('#ffffff', '#ffc928', 12, 0.75, 0.13)


def build_blossom():
    return petal_flower('#ffb3cf', '#ff6f9f', 5, 0.7, 0.32)


def build_tulip():
    red = material('Tulip', '#e8475f', rough=0.45, sss=0.1)
    stem = material('Stem', '#4f9e3a', rough=0.6)
    cylinder('Stem', (0, 0, -0.35), 0.05, 1.0, (0, 0, 0), stem, 0.02)
    for i in range(3):
        a = i * math.tau / 3
        o = sphere(f'Petal.{i}', (math.cos(a) * 0.12, math.sin(a) * 0.12, 0.38), (0.24, 0.17, 0.36), red, 20)
        o.rotation_euler = (0, math.radians(10), a)
    for i, s in enumerate((-1, 1)):
        o = sphere(f'Leaf.{i}', (0.15 * s, 0, -0.45), (0.1, 0.05, 0.42), stem, 16)
        o.rotation_euler = (0, math.radians(25 * s), 0)
    return 0, 15


BUILDERS = {
    'dragon': build_dragon, 'burger': build_burger, 'coin': build_coin,
    'rock0': lambda: build_rock(1), 'rock1': lambda: build_rock(2), 'rock2': lambda: build_rock(5),
    'daisy': build_daisy, 'blossom': build_blossom, 'tulip': build_tulip,
}


# ---------- scene, camera, render ----------

def setup_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    world = bpy.data.worlds.new('World')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.75, 0.85, 0.95, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.55
    scene.world = world
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = FRAME
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.view_settings.view_transform = 'Standard'
    return scene


def add_lights(coll, view):
    # The same warm key / cool rim as the pig, placed relative to the camera so every prop is
    # lit from its viewer's upper left.
    right = view.cross(Vector((0, 0, 1))).normalized()
    for name, energy, toward_light, color in (
            ('Key', 3.2, -view * 6 - right * 4 + Vector((0, 0, 7)), (1.0, 0.96, 0.9)),
            ('Rim', 2.0, view * 6 + right * 5 + Vector((0, 0, 4)), (0.85, 0.9, 1.0))):
        d = bpy.data.lights.new(f'{coll.name}.{name}', 'SUN')
        d.energy = energy
        d.color = color
        d.angle = math.radians(12)
        o = bpy.data.objects.new(d.name, d)
        o.rotation_euler = (-toward_light).to_track_quat('-Z', 'Y').to_euler()
        coll.objects.link(o)


def frame_camera(coll, azimuth, elevation):
    """Orthographic camera from the given direction, zoomed so the model's larger projected
    side fills FILL of the frame, centred on it."""
    az, el = math.radians(azimuth), math.radians(elevation)
    view = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), -math.sin(el)))
    rot = view.to_track_quat('-Z', 'Y')
    right = rot @ Vector((1, 0, 0))
    up = rot @ Vector((0, 1, 0))
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in coll.objects if o.type in ('MESH', 'CURVE')
           for c in o.bound_box]
    xs = [p.dot(right) for p in pts]
    ys = [p.dot(up) for p in pts]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    cam_data = bpy.data.cameras.new(f'{coll.name}.Camera')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = span / FILL
    cam_data.clip_end = 100
    cam = bpy.data.objects.new(cam_data.name, cam_data)
    coll.objects.link(cam)
    cam.location = right * cx + up * cy - view * 20
    cam.rotation_euler = rot.to_euler()
    return cam, view


def main():
    scene = setup_scene()
    # One collection per prop; only the one being rendered is switched on.
    colls, cams = {}, {}
    for name in PROPS:
        coll = bpy.data.collections.new(name)
        scene.collection.children.link(coll)
        bpy.context.view_layer.active_layer_collection = bpy.context.view_layer.layer_collection.children[name]
        azimuth, elevation = BUILDERS[name]()
        cams[name], view = frame_camera(coll, azimuth, elevation)
        add_lights(coll, view)
        colls[name] = coll
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'props.blend'))

    sheet = Image.new('RGBA', (FRAME * len(PROPS), FRAME))
    with tempfile.TemporaryDirectory() as tmp:
        for i, name in enumerate(PROPS):
            for other, coll in colls.items():
                coll.hide_render = other != name
            scene.camera = cams[name]
            path = os.path.join(tmp, f'{name}.png')
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            sheet.paste(Image.open(path), (i * FRAME, 0))
            print('rendered', name, flush=True)
    sheet.save(os.path.join(ROOT, 'props.png'), optimize=True)


if __name__ == '__main__':
    main()
