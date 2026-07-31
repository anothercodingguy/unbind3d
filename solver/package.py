"""Portable, reproducible DGP package creation and loading."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any


def _write_json(archive: zipfile.ZipFile, name: str, payload: dict[str, Any]) -> None:
    info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(info, json.dumps(payload, indent=2, sort_keys=True).encode("utf-8"))


def _write_file(archive: zipfile.ZipFile, name: str, path: Path) -> None:
    info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(info, path.read_bytes())


def create_dgp(run_dir: str | Path, output: str | Path) -> Path:
    run = Path(run_dir)
    target = Path(output)
    manifest = json.loads((run / "manifest.json").read_text())
    plan = json.loads((run / "plan.json").read_text())
    descriptor = {
        "format": "disassembly-graph-package",
        "schema_version": "1.0",
        "assets": ["assembly.glb", "manifest.json", "plan.json"],
        "verification_engine": plan.get("engine"),
        "verified": plan.get("verified"),
        "part_count": len(manifest.get("parts", [])),
    }
    with zipfile.ZipFile(target, "w") as archive:
        _write_json(archive, "dgp.json", descriptor)
        _write_file(archive, "assembly.glb", run / "assembly.glb")
        _write_json(archive, "manifest.json", manifest)
        _write_json(archive, "plan.json", plan)
    return target


def unpack_dgp(source: str | Path, destination: str | Path) -> Path:
    source_path, destination_path = Path(source), Path(destination)
    destination_path.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source_path) as archive:
        required = {"dgp.json", "assembly.glb", "manifest.json", "plan.json"}
        missing = required - set(archive.namelist())
        if missing:
            raise ValueError(f"Invalid DGP package, missing: {sorted(missing)}")
        for name in required:
            (destination_path / name).write_bytes(archive.read(name))
    return destination_path
