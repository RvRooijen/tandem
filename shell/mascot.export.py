# Export the figure of the round button: mascot.blend -> mascot.glb, beside it.
#
#   blender shell/mascot.blend --background --python shell/mascot.export.py
#
# or, with mascot.blend open in Blender: Scripting > Open > this file > Run.
#
# Only what holds still goes into the file: what moves is done in mascot.ts (the
# head nods on its neck, the mouth flaps, the arms are tubes it lays along a
# curve). So the arms are not exported, nothing is animated, and every part is
# written where it is at rest:
#
#   g_Body                          the torso
#   g_Head (at the neck)            g_Skull, g_MouthTop, eyes, pupils, brows, nose, moustache
#     g_Jaw (at the hinge)          g_JawMesh, g_MouthBottom, g_Tongue
#   g_HandL                         the loose hand
#   g_Magnifier, g_Notebook, g_Pencil   each with the hand that holds it
#
# The axes are left as they are in Blender (z up, the face towards -y): mascot.ts
# works in those. The hands and what they hold are the ones of the goo the
# figure was first (the collection Goop, hidden), the hands in the puppet's
# fleece. mascot.ts has a few places written down that it reads off this model
# (the neck, the tip of the moustache); they are printed at the end, to compare.
import os

import bpy

HEAD = ('Skull', 'MouthTop', 'EyeL', 'EyeR', 'PupilL', 'PupilR', 'BrowL', 'BrowR', 'Nose', 'StacheL', 'StacheR')
JAW = ('JawMesh', 'MouthBottom', 'Tongue')
HELD = (
    ('Magnifier', ('MagRing', 'MagGlass', 'MagHandle', 'HandR')),
    ('Notebook', ('BookCover', 'BookPaper', 'CodeA', 'CodeB', 'CodeC', 'HandBook')),
    ('Pencil', ('PenShaft', 'PenTip', 'PenEnd', 'HandPen')),
)
# What is flat stays flat: the faces of the notebook and the plates inside the mouth.
FLAT = {'BookCover', 'BookPaper', 'CodeA', 'CodeB', 'CodeC', 'MouthTop', 'MouthBottom'}
# Where the hand is on the handle of the magnifying glass (mascot.ts: PALM).
GRIP = (0, 0, -1.05)

scene = bpy.context.scene
objects = bpy.data.objects
fleece = bpy.data.materials['Fleece']
out = os.path.join(os.path.dirname(bpy.data.filepath), 'mascot.glb')

# The curves (brows, moustache) are made into meshes as they are evaluated: for that the puppet has to be in view,
# and its mouth shut.
puppet = bpy.data.collections['Muppet']
was_hidden, was_open = puppet.hide_viewport, tuple(objects['M_Jaw'].rotation_euler)
puppet.hide_viewport = False
objects['M_Jaw'].rotation_euler = (0, 0, 0)
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()

# Copies of every part, in a collection of their own that is taken away again: nothing in the scene is changed.
export = bpy.data.collections.new('MascotExport')
scene.collection.children.link(export)


def part(name, source=None, parent=None, location=(0, 0, 0), rotation=(0, 0, 0), scale=(1, 1, 1), refleece=False):
    if source is None:
        made = bpy.data.objects.new('g_' + name, None)
    else:
        mesh = source.data.copy() if source.type == 'MESH' else bpy.data.meshes.new_from_object(source.evaluated_get(depsgraph))
        for polygon in mesh.polygons:
            polygon.use_smooth = name not in FLAT
        if refleece:
            mesh.materials.clear()
            mesh.materials.append(fleece)
        made = bpy.data.objects.new('g_' + name, mesh)
    made.parent = parent
    made.location, made.rotation_euler, made.scale = location, rotation, scale
    export.objects.link(made)
    return made


try:
    part('Body', objects['M_Torso'])
    head = part('Head', location=objects['M_Head'].location)
    for name in HEAD:
        part(name, objects['M_' + name], head, objects['M_' + name].location)
    jaw = part('Jaw', parent=head, location=objects['M_Jaw'].location)
    for name in JAW:
        part(name, objects['M_' + name], jaw, objects['M_' + name].location)

    part('HandL', objects['HandL'], refleece=True)
    for holder, names in HELD:
        root = part(holder)
        for name in names:
            source, hand = objects[name], name.startswith('Hand')
            if name == 'HandR':
                part(name, source, root, GRIP, refleece=True)
            else:
                part(name, source, root, source.location, source.rotation_euler, source.scale if hand else (1, 1, 1), refleece=hand)

    bpy.context.view_layer.update()
    for other in bpy.context.view_layer.objects:
        other.select_set(False)
    for made in export.objects:
        made.select_set(True)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_yup=False, export_apply=True, export_animations=False)
finally:
    for made in list(export.objects):
        mesh = made.data
        bpy.data.objects.remove(made, do_unlink=True)
        if mesh and mesh.users == 0:
            bpy.data.meshes.remove(mesh)
    bpy.data.collections.remove(export)
    objects['M_Jaw'].rotation_euler = was_open
    puppet.hide_viewport = was_hidden

neck = objects['M_Head'].location
tip = objects['M_StacheL'].data.splines[0].points[3].co
print(f'mascot.glb written: {os.path.getsize(out)} bytes, {out}')
print('for mascot.ts  NECK       ', tuple(round(c, 3) for c in neck))
print('for mascot.ts  STACHE_TIP ', tuple(round(tip[i] + neck[i], 3) for i in range(3)))
