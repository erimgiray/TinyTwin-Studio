# TinyTwin Studio: run by Blender in background mode on a .blend file.
#   blender -b <file.blend> --factory-startup --python export_blend.py -- <out_dir>
# Writes <out_dir>/scene.glb (every object, modifiers applied) and <out_dir>/scene.json
# (units, collections, objects, materials, images and print checks).
import bpy, bmesh, json, os, sys, traceback

out_dir = sys.argv[sys.argv.index("--") + 1]
os.makedirs(out_dir, exist_ok=True)
warnings = []


def r(v, n=4):
    return round(float(v), n)


def mesh_checks(ob, depsgraph):
    """Stats on the evaluated (modifiers applied) mesh, in world space."""
    ev = ob.evaluated_get(depsgraph)
    me = ev.to_mesh()
    try:
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.transform(ob.matrix_world)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        open_edges = sum(1 for e in bm.edges if len(e.link_faces) == 1)
        bad_edges = sum(1 for e in bm.edges if len(e.link_faces) > 2)
        loose = sum(1 for e in bm.edges if not e.link_faces)
        # connected pieces (islands)
        seen, islands = set(), 0
        for v in bm.verts:
            if v.index in seen:
                continue
            islands += 1
            stack = [v]
            seen.add(v.index)
            while stack:
                cur = stack.pop()
                for e in cur.link_edges:
                    o = e.other_vert(cur)
                    if o.index not in seen:
                        seen.add(o.index)
                        stack.append(o)
        vol = abs(bm.calc_volume(signed=True)) if open_edges == 0 and bad_edges == 0 else None
        return {
            "verts": len(me.vertices), "faces": len(me.polygons), "tris": len(bm.faces),
            "openEdges": open_edges, "nonManifoldEdges": bad_edges, "looseEdges": loose,
            "islands": islands, "volume": vol,
        }
    finally:
        bm.free()
        ev.to_mesh_clear()


def material_info(m):
    info = {"name": m.name, "users": m.users, "color": [r(c, 3) for c in m.diffuse_color[:3]],
            "metallic": r(m.metallic, 3), "roughness": r(m.roughness, 3), "images": [], "exportable": True}
    if m.use_nodes and m.node_tree:
        nodes = m.node_tree.nodes
        bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf:
            bc = bsdf.inputs.get("Base Color")
            if bc is not None and not bc.is_linked:
                info["color"] = [r(c, 3) for c in bc.default_value[:3]]
            for key in ("Metallic", "Roughness"):
                inp = bsdf.inputs.get(key)
                if inp is not None and not inp.is_linked:
                    info[key.lower()] = r(inp.default_value, 3)
        else:
            info["exportable"] = False
        info["images"] = sorted({n.image.name for n in nodes if n.type == "TEX_IMAGE" and n.image})
        procedural = [n.bl_idname for n in nodes if n.type in ("TEX_NOISE", "TEX_VORONOI", "TEX_WAVE", "TEX_MUSGRAVE", "TEX_MAGIC", "TEX_GRADIENT", "TEX_CHECKER", "TEX_BRICK")]
        if procedural:
            info["procedural"] = True
    return info


def collection_tree(col):
    return {"name": col.name, "objects": [o.name for o in col.objects],
            "children": [collection_tree(c) for c in col.children],
            "hidden": bool(col.hide_viewport or col.hide_render)}


try:
    scene = bpy.context.scene
    us = scene.unit_settings
    depsgraph = bpy.context.evaluated_depsgraph_get()
    view_layer = bpy.context.view_layer

    objects = []
    for ob in scene.objects:
        try:
            visible = ob.visible_get(view_layer=view_layer)
        except Exception:
            visible = not ob.hide_viewport
        o = {
            "name": ob.name, "type": ob.type, "parent": ob.parent.name if ob.parent else None,
            "collections": [c.name for c in ob.users_collection], "visible": bool(visible),
            "hideRender": bool(ob.hide_render),
            "location": [r(v) for v in ob.matrix_world.translation],
            "dimensions": [r(v) for v in ob.dimensions],
            "modifiers": [{"name": m.name, "type": m.type, "on": bool(m.show_viewport)} for m in getattr(ob, "modifiers", [])],
            "materials": [s.material.name for s in getattr(ob, "material_slots", []) if s.material],
        }
        if ob.type == "MESH":
            try:
                o["mesh"] = mesh_checks(ob, depsgraph)
            except Exception as e:
                warnings.append(f"Could not measure {ob.name}: {e}")
            me = ob.data
            o["shapeKeys"] = [k.name for k in me.shape_keys.key_blocks] if me.shape_keys else []
            o["vertexGroups"] = [g.name for g in ob.vertex_groups]
            o["uvMaps"] = [u.name for u in me.uv_layers]
        elif ob.type == "ARMATURE":
            o["bones"] = len(ob.data.bones)
        elif ob.type == "CAMERA":
            o["lens"] = r(ob.data.lens, 2)
        elif ob.type == "LIGHT":
            o["light"] = {"kind": ob.data.type, "energy": r(ob.data.energy, 2)}
        if ob.keys():
            o["props"] = {k: (ob[k] if isinstance(ob[k], (int, float, str, bool)) else str(ob[k])) for k in ob.keys() if not k.startswith("_")}
        objects.append(o)

    images = []
    for im in bpy.data.images:
        if im.type not in ("IMAGE",) or im.name in ("Render Result", "Viewer Node"):
            continue
        path = bpy.path.abspath(im.filepath) if im.filepath else ""
        packed = im.packed_file is not None
        missing = not packed and bool(path) and not os.path.exists(path)
        if missing:
            warnings.append(f"Texture '{im.name}' is missing on disk ({path}); it will show blank.")
        images.append({"name": im.name, "size": list(im.size), "packed": packed, "path": path, "missing": missing, "users": im.users})

    materials = [material_info(m) for m in bpy.data.materials if m.users]
    for m in materials:
        if not m["exportable"]:
            warnings.append(f"Material '{m['name']}' has no Principled BSDF, so its colours are approximate here.")
        elif m.get("procedural"):
            warnings.append(f"Material '{m['name']}' uses procedural textures, which only show in Blender (bake them for print).")

    # Make every object exportable, including hidden ones, so the viewer can toggle them.
    for ob in scene.objects:
        try:
            ob.hide_set(False)
        except Exception:
            pass
        ob.hide_viewport = False
    for lc in view_layer.layer_collection.children:
        def unhide(c):
            c.exclude = False
            c.hide_viewport = False
            c.collection.hide_viewport = False
            for ch in c.children:
                unhide(ch)
        unhide(lc)

    glb = os.path.join(out_dir, "scene.glb")
    kwargs = dict(filepath=glb, export_format="GLB", use_visible=False, use_renderable=False,
                  use_selection=False, export_apply=True, export_extras=True, export_cameras=False,
                  export_lights=False, export_yup=True)
    try:
        bpy.ops.export_scene.gltf(**kwargs, export_animations=False)
    except TypeError:
        bpy.ops.export_scene.gltf(**kwargs)

    report = {
        "ok": True,
        "file": bpy.data.filepath,
        "blender": bpy.app.version_string,
        "savedWith": ".".join(str(v) for v in bpy.data.version),
        "scene": scene.name,
        "units": {"system": us.system, "length": us.length_unit, "scale": r(us.scale_length, 6),
                  # millimetres per Blender unit (glTF keeps Blender units as metres-unscaled)
                  "mmPerUnit": r((us.scale_length if us.system != "NONE" else 1.0) * 1000.0, 6)},
        "frames": [scene.frame_start, scene.frame_end],
        "collections": collection_tree(scene.collection),
        "objects": objects,
        "materials": materials,
        "images": images,
        "counts": {k: len(getattr(bpy.data, k)) for k in ("objects", "meshes", "materials", "images", "actions", "armatures")},
        "warnings": warnings,
    }
except Exception:
    report = {"ok": False, "error": traceback.format_exc(), "warnings": warnings}

with open(os.path.join(out_dir, "scene.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, indent=1)
print("TINYTWIN_DONE" if report.get("ok") else "TINYTWIN_FAILED")
