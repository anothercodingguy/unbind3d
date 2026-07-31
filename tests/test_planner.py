from __future__ import annotations

import json
import zipfile
from pathlib import Path

import numpy as np
import pytest

trimesh = pytest.importorskip("trimesh")

from solver.geometry import direction_label, load_parts
from solver.package import create_dgp
from solver.planner import DisassemblySolver, SolverConfig
from solver.types import DirectionTest


def make_run(tmp_path: Path) -> tuple[Path, Path]:
    """Create an assembly where Tray separates from Housing along -X."""
    scene = trimesh.Scene()
    target = trimesh.creation.box(extents=[1, 1, 1])
    blocker = trimesh.creation.box(extents=[1, 1, 1])
    blocker.apply_translation([1.2, 0, 0])
    scene.add_geometry(target, node_name="Tray", geom_name="Tray")
    scene.add_geometry(blocker, node_name="Housing", geom_name="Housing")
    glb = tmp_path / "assembly.glb"
    glb.write_bytes(scene.export(file_type="glb"))
    manifest = {
        "parts": [
            {"part_id": "tray", "source_name": "Tray", "glb_node": "Tray", "order": 0, "hierarchy_depth": 0},
            {"part_id": "housing", "source_name": "Housing", "glb_node": "Housing", "order": 1, "hierarchy_depth": 0},
        ]
    }
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    return glb, manifest_path


def solver_for(glb: Path, manifest_path: Path) -> DisassemblySolver:
    return DisassemblySolver(
        load_parts(glb, json.loads(manifest_path.read_text())),
        SolverConfig(allow_aabb_fallback=True),
    )


def test_target_analysis_records_all_candidate_directions(tmp_path: Path) -> None:
    glb, manifest = make_run(tmp_path)
    analysis = solver_for(glb, manifest).analyze_target("Tray")
    target = analysis["node_evaluations"][0]
    assert analysis["target"]["id"] == "tray"
    assert len(target["tested"]) == 26
    assert any(item["result"] == "blocked" for item in target["tested"])
    assert any(item["result"] == "free" for item in target["tested"])
    # A target with one clear exit has no required prerequisite, even though
    # other attempted exit directions are correctly recorded as blocked.
    assert analysis["count"] == 0


def test_target_analysis_recursively_returns_prerequisite_order(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    glb, manifest = make_run(tmp_path)
    solver = solver_for(glb, manifest)

    def fake_test(part, direction):  # type: ignore[no-untyped-def]
        blocked = part.id == "tray"
        return DirectionTest(
            direction=direction,
            label=direction_label(direction),
            result="blocked" if blocked else "free",
            travel_distance=4.0,
            blockers=["housing"] if blocked else [],
            blocker_details=[{"part_id": "housing", "time_of_impact": 0.25, "distance": 1.0, "contact": []}] if blocked else [],
            toi=0.25 if blocked else None,
            verified=True,
        )

    monkeypatch.setattr(solver, "test_direction", fake_test)
    analysis = solver.analyze_target("tray")
    assert analysis["prerequisite_order"] == ["housing"]
    assert analysis["count"] == 1
    assert analysis["dependencies"] == [{"id": "housing", "name": "Housing", "order": 1, "fastener": {"value": False, "reason": None}}]
    assert any(edge["required"] for edge in analysis["dependency_graph"]["edges"])
    assert analysis["tree"]["children"][0]["part_id"] == "housing"


def test_mating_contact_can_separate_without_becoming_a_dependency(tmp_path: Path) -> None:
    scene = trimesh.Scene()
    target = trimesh.creation.box(extents=[1, 1, 1])
    mating = trimesh.creation.box(extents=[1, 1, 1])
    mating.apply_translation([1.0, 0, 0])  # exact face-to-face CAD contact
    scene.add_geometry(target, node_name="Tray", geom_name="Tray")
    scene.add_geometry(mating, node_name="Housing", geom_name="Housing")
    glb = tmp_path / "contact.glb"
    glb.write_bytes(scene.export(file_type="glb"))
    manifest = {"parts": [
        {"part_id": "tray", "source_name": "Tray", "glb_node": "Tray", "order": 0, "hierarchy_depth": 0},
        {"part_id": "housing", "source_name": "Housing", "glb_node": "Housing", "order": 1, "hierarchy_depth": 0},
    ]}
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    solver = solver_for(glb, path)
    tests = solver._evaluate("tray")["tested"]
    assert next(test for test in tests if test["direction"] == "-X")["result"] == "free"



def test_dgp_contains_target_workspace(tmp_path: Path) -> None:
    glb, manifest = make_run(tmp_path)
    run = tmp_path / "run"
    run.mkdir()
    (run / "assembly.glb").write_bytes(glb.read_bytes())
    (run / "manifest.json").write_bytes(manifest.read_bytes())
    (run / "plan.json").write_text(json.dumps(solver_for(glb, manifest).workspace()))
    package = create_dgp(run, run / "run.dgp")
    with zipfile.ZipFile(package) as archive:
        assert {"dgp.json", "assembly.glb", "manifest.json", "plan.json"} <= set(archive.namelist())
        assert json.loads(archive.read("plan.json"))["mode"] == "target_prerequisite_workspace"
