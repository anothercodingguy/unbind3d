"""Mesh loading and deterministic geometric primitives."""

from __future__ import annotations

import itertools
import math
import re
from pathlib import Path
from typing import Any, Iterable

import numpy as np

from .types import Part, vec

FASTENER_RE = re.compile(r"(?:^|[_\-\s])(scr(?:ew|w)?|bolt|fastener|nut)(?:[_\-\s\d]|$)", re.I)


def canonical_directions() -> list[np.ndarray]:
    """Return the 26 normalized vectors in stable geometric order."""
    raw = [np.array(item, dtype=float) for item in itertools.product((-1, 0, 1), repeat=3) if item != (0, 0, 0)]
    # Axial directions first, then edge diagonals, then corners. This is a fixed
    # geometric enumeration, not a name-based tie breaker.
    raw.sort(key=lambda item: (np.count_nonzero(item) != 1, np.count_nonzero(item), tuple(-item)))
    return [item / np.linalg.norm(item) for item in raw]


def direction_label(direction: np.ndarray) -> str:
    axes = ("X", "Y", "Z")
    tokens: list[str] = []
    for axis, component in zip(axes, direction):
        if abs(component) > 1e-8:
            tokens.append(("+" if component > 0 else "-") + axis)
    return " ".join(tokens)


def scene_bounds(parts: Iterable[Part]) -> np.ndarray:
    part_list = list(parts)
    lows = np.stack([part.bounds[0] for part in part_list])
    highs = np.stack([part.bounds[1] for part in part_list])
    return np.array([lows.min(axis=0), highs.max(axis=0)])


def aabb_intersects(a: np.ndarray, b: np.ndarray, tolerance: float = 1e-9) -> bool:
    return bool(np.all(a[0] < b[1] - tolerance) and np.all(a[1] > b[0] + tolerance))


def swept_aabb(bounds: np.ndarray, translation: np.ndarray) -> np.ndarray:
    end = bounds + translation
    return np.array([np.minimum(bounds[0], end[0]), np.maximum(bounds[1], end[1])])


def segment_hits_aabb(start: np.ndarray, end: np.ndarray, bounds: np.ndarray, radius: float) -> tuple[bool, float | None]:
    """Slab intersection against an inflated AABB, returning segment time."""
    low = bounds[0] - radius
    high = bounds[1] + radius
    direction = end - start
    entry, exit_ = 0.0, 1.0
    for index in range(3):
        if abs(direction[index]) < 1e-12:
            if start[index] < low[index] or start[index] > high[index]:
                return False, None
            continue
        t0 = (low[index] - start[index]) / direction[index]
        t1 = (high[index] - start[index]) / direction[index]
        entry = max(entry, min(t0, t1))
        exit_ = min(exit_, max(t0, t1))
        if entry > exit_:
            return False, None
    return 0.0 <= entry <= 1.0, max(0.0, entry)


def containment_depth(part: Part, parts: Iterable[Part]) -> int:
    """Count other bounding boxes that fully contain the part's center."""
    center = part.center
    depth = 0
    for other in parts:
        if other.id == part.id:
            continue
        if np.all(center > other.bounds[0]) and np.all(center < other.bounds[1]):
            depth += 1
    return depth


def infer_fastener(name: str, mesh: Any) -> tuple[bool, str | None]:
    """Provide non-decisive fastener metadata from name and axial shape."""
    name_hint = bool(FASTENER_RE.search(name))
    vertices = np.asarray(mesh.vertices)
    if len(vertices) < 4:
        return name_hint, "name" if name_hint else None
    centered = vertices - vertices.mean(axis=0)
    _, singular_values, _ = np.linalg.svd(centered, full_matrices=False)
    axial_hint = bool(len(singular_values) >= 2 and singular_values[0] > 2.5 * max(singular_values[1], 1e-9))
    if name_hint and axial_hint:
        return True, "name_and_axial_geometry"
    if name_hint:
        return True, "name"
    if axial_hint:
        return True, "axial_geometry"
    return False, None


def principal_axis(part: Part) -> np.ndarray:
    vertices = np.asarray(part.mesh.vertices)
    centered = vertices - vertices.mean(axis=0)
    _, _, right = np.linalg.svd(centered, full_matrices=False)
    axis = np.asarray(right[0], dtype=float)
    # Stable sign: largest-magnitude component is positive.
    major = int(np.argmax(np.abs(axis)))
    if axis[major] < 0:
        axis *= -1
    return axis / np.linalg.norm(axis)


def part_face_support(part: Part, direction: np.ndarray) -> np.ndarray:
    vertices = np.asarray(part.mesh.vertices)
    return vertices[int(np.argmax(vertices @ direction))]


def infer_descriptive_name(raw_name: str, mesh: Any, is_fastener: bool, fallback_index: int = 0) -> str:
    """Infer a human-readable engineering name if the raw name is generic."""
    clean_name = raw_name.strip()
    if not re.match(r"^(?:mesh|part|object|node)[_\-\s]*\d+$", clean_name, re.I):
        return clean_name

    match = re.search(r"\d+", clean_name)
    num_str = match.group(0) if match else f"{fallback_index:03d}"

    bounds = np.asarray(mesh.bounds, dtype=float)
    extent = bounds[1] - bounds[0]
    sorted_ext = sorted(extent)
    is_flat = sorted_ext[0] < 0.12 * max(sorted_ext[2], 1e-6)
    is_round = abs(extent[0] - extent[2]) < 0.15 * max(extent[0], extent[2], 1e-6)

    if is_fastener:
        if sorted_ext[2] > 2.5 * sorted_ext[1]:
            return f"Bolt_{num_str}"
        return f"Screw_{num_str}"

    if is_flat:
        return f"Cover_Plate_{num_str}" if sorted_ext[2] > 15 else f"PCB_Board_{num_str}"

    if is_round:
        if sorted_ext[2] > 1.8 * sorted_ext[0]:
            return f"Cylinder_Housing_{num_str}"
        return f"Lens_Mount_{num_str}"

    if max(extent) > 25:
        return f"Main_Base_{num_str}"

    return f"Support_Bracket_{num_str}"


def load_parts(glb_path: str | Path, manifest: dict[str, Any]) -> list[Part]:
    """Load each GLB mesh node as a world-space, individually removable part."""
    try:
        import trimesh
    except ImportError as exc:  # pragma: no cover - dependency issue
        raise RuntimeError("trimesh is required; install requirements.txt") from exc

    scene = trimesh.load(Path(glb_path), force="scene")
    if not isinstance(scene, trimesh.Scene):
        wrapped = trimesh.Scene()
        wrapped.add_geometry(scene, node_name="part")
        scene = wrapped

    manifest_parts = list(manifest.get("parts", []))
    by_node = {item.get("glb_node"): item for item in manifest_parts}
    known_nodes = sorted((str(node) for node in by_node if node), key=len, reverse=True)
    grouped: dict[str, list[Any]] = {str(item["part_id"]): [] for item in manifest_parts}
    unknown: list[tuple[str, Any]] = []
    for node_name in scene.graph.nodes_geometry:
        transform, geometry_name = scene.graph.get(node_name)
        source = scene.geometry[geometry_name].copy()
        source.apply_transform(transform)
        node = str(node_name)
        entry = by_node.get(node)
        # Blender's glTF exporter creates suffixed nodes for objects that have
        # multiple material primitives. They remain one Blender object and must
        # move as one disassembly part.
        if entry is None:
            matching = next((name for name in known_nodes if node.startswith(f"{name}_")), None)
            entry = by_node.get(matching) if matching else None
        if entry:
            grouped[str(entry["part_id"])].append(source)
        else:
            unknown.append((node, source))

    parts: list[Part] = []
    for fallback_index, entry in enumerate(sorted(manifest_parts, key=lambda item: int(item.get("order", 1_000_000)))):
        meshes = grouped.get(str(entry["part_id"]), [])
        if not meshes:
            continue
        mesh = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
        node_name = str(entry.get("glb_node", entry.get("source_name", entry["part_id"])))
        source_name = entry.get("source_name", node_name)
        fastener, reason = infer_fastener(source_name, mesh)
        descriptive_name = infer_descriptive_name(source_name, mesh, fastener, fallback_index)
        bounds = np.asarray(mesh.bounds, dtype=float)
        parts.append(
            Part(
                id=entry.get("part_id", f"part_{fallback_index:03d}_{node_name}"),
                name=descriptive_name,
                node=node_name,
                order=int(entry.get("order", fallback_index)),
                parent=entry.get("parent"),
                hierarchy_depth=int(entry.get("hierarchy_depth", 0)),
                mesh=mesh,
                bounds=bounds,
                is_fastener=fastener,
                fastener_reason=reason,
            )
        )

    # Keep arbitrary third-party GLBs usable even if no Blender manifest is
    # available. Such geometry is treated as one part per unmatched node.
    for fallback_index, (node_name, mesh) in enumerate(sorted(unknown, key=lambda item: item[0]), start=len(parts)):
        fastener, reason = infer_fastener(node_name, mesh)
        parts.append(
            Part(
                id=f"part_{fallback_index:03d}_{node_name}",
                name=node_name,
                node=node_name,
                order=1_000_000 + fallback_index,
                parent=None,
                hierarchy_depth=0,
                mesh=mesh,
                bounds=np.asarray(mesh.bounds, dtype=float),
                is_fastener=fastener,
                fastener_reason=reason,
            )
        )
    if not parts:
        raise ValueError("No mesh nodes were found in the GLB")
    return parts


def geometry_summary(part: Part) -> dict[str, Any]:
    return {
        "id": part.id,
        "name": part.name,
        "node": part.node,
        "parent": part.parent,
        "order": part.order,
        "hierarchy_depth": part.hierarchy_depth,
        "bounds": [vec(part.bounds[0]), vec(part.bounds[1])],
        "triangle_count": int(len(part.mesh.faces)),
        "fastener": {"value": part.is_fastener, "reason": part.fastener_reason},
    }
