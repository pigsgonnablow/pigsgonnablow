"""Builds the pig in Blender and renders it to the game's sprite sheet.

Run with the Blender Python module (pip install bpy pillow):
    python blender/make_pig.py

Writes:
    blender/pig.blend   the model, open it in Blender to tweak
    pig.png             sprite sheet used by index.html
                        columns = mouth open level (0..5, one per burger fed)
                        rows    = 0 normal, 1 warning (about to blow),
                                  2 the pig's ground shadow alone (column 0 only), so the game
                                  can keep it on the floor while the pig jumps
"""
import math
import os
import tempfile

import bpy
from mathutils import Vector
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FRAME = 256
LEVELS = 6


def srgb(hex_color, alpha=1.0):
    h = hex_color.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, alpha)


def material(name, color, rough=0.55, sss=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = srgb(color)
    bsdf.inputs['Roughness'].default_value = rough
    if sss:
        bsdf.inputs['Subsurface Weight'].default_value = sss
        bsdf.inputs['Subsurface Radius'].default_value = (1.0, 0.4, 0.3)
        bsdf.inputs['Subsurface Scale'].default_value = 0.15
    return m


def smooth(obj, levels=2):
    for p in obj.data.polygons:
        p.use_smooth = True
    mod = obj.modifiers.new('Subsurf', 'SUBSURF')
    mod.levels = mod.render_levels = levels


def sphere(name, loc, scale, mat, segs=32):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=segs // 2, location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    o.data.materials.append(mat)
    smooth(o, 1)
    return o


def cylinder(name, loc, radius, depth, rot, mat, bevel=0.06):
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=radius, depth=depth,
                                        location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.data.materials.append(mat)
    b = o.modifiers.new('Bevel', 'BEVEL')
    b.width = bevel
    b.segments = 4
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def ear(name, side, mat):
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=0.26, radius2=0.02, depth=0.5,
                                    location=(0.42 * side, -0.72, 0.98),
                                    rotation=(math.radians(-25), math.radians(28 * side), 0))
    o = bpy.context.object
    o.name = name
    o.scale = (1.0, 0.45, 1.0)
    o.data.materials.append(mat)
    smooth(o, 2)
    return o


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    pink = material('PigSkin', '#ffb5c2', rough=0.5, sss=0.15)
    pink_dark = material('PigEar', '#ff7f96', rough=0.5, sss=0.1)
    snout = material('PigSnout', '#ff9eb0', rough=0.45, sss=0.1)
    dark = material('Dark', '#3a2020', rough=0.3)
    mouth = material('Mouth', '#7a1f2b', rough=0.6)
    white = material('Shine', '#ffffff', rough=0.2)
    hoof = material('Hoof', '#8a5a5a', rough=0.6)

    parts = []
    parts.append(sphere('Body', (0, 0.1, -0.05), (1.0, 1.05, 0.88), pink))
    parts.append(sphere('Head', (0, -0.85, 0.25), (0.78, 0.75, 0.75), pink))
    parts.append(cylinder('Snout', (0, -1.6, 0.12), 0.34, 0.3,
                          (math.radians(90), 0, 0), snout, bevel=0.1))
    for s in (-1, 1):
        parts.append(sphere(f'Nostril.{s}', (0.12 * s, -1.755, 0.14), (0.055, 0.03, 0.085), dark, 16))
        parts.append(sphere(f'Eye.{s}', (0.3 * s, -1.43, 0.55), (0.11, 0.08, 0.13), dark, 24))
        parts.append(sphere(f'EyeShine.{s}', (0.3 * s + 0.035, -1.5, 0.6), (0.035, 0.02, 0.035), white, 12))
        parts.append(ear(f'Ear.{s}', s, pink_dark))
        for fy in (-0.35, 0.55):
            parts.append(cylinder(f'Leg.{s}.{fy}', (0.5 * s, fy, -0.82), 0.2, 0.42, (0, 0, 0), pink, 0.05))
            parts.append(cylinder(f'Hoof.{s}.{fy}', (0.5 * s, fy, -1.03), 0.21, 0.08, (0, 0, 0), hoof, 0.03))

    mouth_obj = sphere('Mouth', (0, -1.42, -0.26), (0.28, 0.1, 0.12), mouth, 24)
    parts.append(mouth_obj)

    # curly tail
    bpy.ops.curve.primitive_bezier_circle_add(radius=0.12, location=(0, 1.25, 0.25),
                                              rotation=(0, math.radians(90), 0))
    tail = bpy.context.object
    tail.name = 'Tail'
    tail.data.bevel_depth = 0.04
    tail.data.materials.append(pink_dark)

    # The pig gets redder and puffier as it is about to blow
    body_bsdf = pink.node_tree.nodes['Principled BSDF']

    # camera: orthographic, looking down slightly, matching the game's view
    cam_data = bpy.data.cameras.new('Camera')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = 2.9
    cam = bpy.data.objects.new('Camera', cam_data)
    scene.collection.objects.link(cam)
    cam.location = (0, -10, 4.2)
    direction = Vector((0, -0.2, 0.0)) - cam.location
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam

    # lighting: warm key, cool fill, soft sky
    def light(name, kind, energy, loc, color, size=1.0):
        d = bpy.data.lights.new(name, kind)
        d.energy = energy
        d.color = color
        if kind == 'AREA':
            d.size = size
        if kind == 'SUN':
            d.angle = math.radians(12)  # soft-edged shadows
        o = bpy.data.objects.new(name, d)
        o.location = loc
        o.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        scene.collection.objects.link(o)

    light('Key', 'SUN', 3.2, (-4, -6, 7), (1.0, 0.96, 0.9))
    light('Rim', 'SUN', 2.0, (5, 6, 4), (0.85, 0.9, 1.0))
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

    # Floor under the hooves that only shows the shadows falling on it. It is hidden for the pig
    # frames and shown, with the pig itself hidden from the camera, for the shadow frame.
    bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, -1.07))
    floor = bpy.context.object
    floor.name = 'ShadowFloor'
    floor.is_shadow_catcher = True
    floor.hide_render = True

    return scene, mouth_obj, body_bsdf, floor


def main():
    scene, mouth_obj, body_bsdf, floor = build()
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'pig.blend'))

    sheet = Image.new('RGBA', (FRAME * LEVELS, FRAME * 3))
    with tempfile.TemporaryDirectory() as tmp:
        for row, color in enumerate(('#ffb5c2', '#ff7f96')):
            body_bsdf.inputs['Base Color'].default_value = srgb(color)
            for lvl in range(LEVELS):
                k = 1 + lvl * 0.22
                mouth_obj.scale = (0.28 * k, 0.1, 0.1 * (1 + lvl * 0.35))
                path = os.path.join(tmp, f'pig_{row}_{lvl}.png')
                scene.render.filepath = path
                bpy.ops.render.render(write_still=True)
                sheet.paste(Image.open(path), (lvl * FRAME, row * FRAME))
                print('rendered', row, lvl, flush=True)

        # The shadow gets its own near-overhead sun, so it stays a compact pool under the pig
        # (the key and rim lights would throw it far off the frame).
        lights = [o for o in scene.objects if o.type == 'LIGHT']
        for o in lights:
            o.hide_render = True
        shadow_sun = bpy.data.lights.new('ShadowSun', 'SUN')
        shadow_sun.energy = 3.0
        shadow_sun.angle = math.radians(25)
        sun_obj = bpy.data.objects.new('ShadowSun', shadow_sun)
        sun_obj.location = (-1.2, -5, 8)
        sun_obj.rotation_euler = (Vector((0, 0, 0)) - sun_obj.location).to_track_quat('-Z', 'Y').to_euler()
        scene.collection.objects.link(sun_obj)
        floor.hide_render = False
        pig_parts = [o for o in scene.objects if o.type in ('MESH', 'CURVE') and o is not floor]
        for o in pig_parts:
            o.visible_camera = False
        path = os.path.join(tmp, 'pig_shadow.png')
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        # Where the hooves meet the floor the catcher goes fully black; capping and blurring the alpha blends
        # those spots into the pool so they don't show as dots while the pig is in the air.
        shadow = Image.open(path).convert('RGBA')
        shadow.putalpha(shadow.getchannel('A').point(lambda v: min(v, 200)).filter(ImageFilter.GaussianBlur(4)))
        # Fade the last few pixels to nothing so the pool never ends in a hard line at the frame edge.
        edge = 12
        fade = Image.new('L', (FRAME, FRAME))
        fade.putdata([int(255 * min(1, x / edge, y / edge, (FRAME - 1 - x) / edge, (FRAME - 1 - y) / edge))
                      for y in range(FRAME) for x in range(FRAME)])
        shadow.putalpha(Image.composite(shadow.getchannel('A'), Image.new('L', (FRAME, FRAME)), fade))
        sheet.paste(shadow, (0, 2 * FRAME))
        print('rendered shadow', flush=True)
        for o in pig_parts:
            o.visible_camera = True
        floor.hide_render = True
        bpy.data.objects.remove(sun_obj)
        for o in lights:
            o.hide_render = False
    sheet.save(os.path.join(ROOT, 'pig.png'), optimize=True)


if __name__ == '__main__':
    main()
