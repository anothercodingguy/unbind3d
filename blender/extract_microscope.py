"""Blender 4.5+ headless extractor for the target hackathon collection.

Usage:
blender -b input.blend -P blender/extract_microscope.py -- \
  --collection Microscope_circuit --out run
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def arguments() -> argparse.Namespace:
    argv = sys.argv
    if "--" not in argv:
        raise SystemExit("Pass extractor arguments after --")
    parser = argparse.ArgumentParser()
    parser.add_argument("--collection", default="ALL")
    parser.add_argument("--out", required=True)
    return parser.parse_args(argv[argv.index("--") + 1 :])


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_") or "part"


def object_path(obj: bpy.types.Object) -> str:
    names = [obj.name]
    parent = obj.parent
    while parent:
        names.append(parent.name)
        parent = parent.parent
    return "/".join(reversed(names))


def hierarchy_depth(obj: bpy.types.Object) -> int:
    depth = 0
    parent = obj.parent
    while parent:
        depth += 1
        parent = parent.parent
    return depth


def collect_meshes(collection: bpy.types.Collection | None = None) -> list[bpy.types.Object]:
    if collection is None:
        objects = {obj.name_full: obj for obj in bpy.data.objects if obj.type == "MESH"}
        return sorted(objects.values(), key=lambda obj: object_path(obj))
    objects: dict[str, bpy.types.Object] = {}
    for child in [collection, *collection.children_recursive]:
        for obj in child.objects:
            if obj.type == "MESH":
                objects[obj.name_full] = obj
    return sorted(objects.values(), key=lambda obj: object_path(obj))


def mesh_summary(obj: bpy.types.Object, depsgraph: bpy.types.Depsgraph) -> tuple[list[list[float]], list[list[float]], int]:
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        world_vertices = [obj.matrix_world @ vertex.co for vertex in mesh.vertices]
        if not world_vertices:
            return [[0, 0, 0], [0, 0, 0]], [[0, 0, 0]], 0
        lower = [min(vertex[i] for vertex in world_vertices) for i in range(3)]
        upper = [max(vertex[i] for vertex in world_vertices) for i in range(3)]
        return [lower, upper], [list(vertex) for vertex in world_vertices[:1]], len(mesh.polygons)
    finally:
        evaluated.to_mesh_clear()


def main() -> None:
    args = arguments()
    output = Path(args.out)
    output.mkdir(parents=True, exist_ok=True)
    collection = None
    if args.collection and args.collection.strip().upper() not in ("ALL", "SCENE", "SCENE COLLECTION", "*"):
        collection = bpy.data.collections.get(args.collection)
    objects = collect_meshes(collection)
    if not objects:
        raise SystemExit(f"No mesh objects found in Blender scene or collection {args.collection!r}")


    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    glb_path = output / "assembly.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
    )

    depsgraph = bpy.context.evaluated_depsgraph_get()
    parts = []
    for order, obj in enumerate(objects):
        bounds, _, triangle_count = mesh_summary(obj, depsgraph)
        parts.append(
            {
                "part_id": f"part_{order:03d}_{slug(obj.name)}",
                "source_name": obj.name,
                "source_path": object_path(obj),
                "glb_node": obj.name,
                "parent": obj.parent.name if obj.parent else None,
                "order": order,
                "hierarchy_depth": hierarchy_depth(obj),
                "world_matrix": [[round(value, 8) for value in row] for row in obj.matrix_world],
                "bounds": bounds,
                "triangle_count": triangle_count,
            }
        )
    manifest = {
        "schema_version": "1.0",
        "source": {"blend": bpy.data.filepath, "collection": args.collection, "blender_version": bpy.app.version_string},
        "parts": parts,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({"glb": str(glb_path), "manifest": str(output / "manifest.json"), "parts": len(parts)}, indent=2))


if __name__ == "__main__":
    main()
