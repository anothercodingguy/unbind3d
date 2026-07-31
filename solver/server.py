"""Local API for Blender extraction and target-scoped dependency analysis."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .geometry import load_parts
from .package import create_dgp
from .planner import DisassemblySolver

app = FastAPI(title="Unbind3D Target Analysis API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
ROOT_DIR = Path(__file__).resolve().parents[1]
EXTRACTOR = ROOT_DIR / "blender" / "extract_microscope.py"


def _run(command: list[str], *, cwd: Path) -> None:
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)
    except FileNotFoundError as exc:
        raise RuntimeError(
            "Blender was not found. Install Blender 4.5+ or set BLENDER_BIN to its executable path."
        ) from exc
    if result.returncode:
        details = (result.stderr or result.stdout).strip()[-2000:]
        raise RuntimeError(details or f"Command failed: {' '.join(command)}")


def _prepare_blend(blend_path: Path, run_dir: Path) -> Path:
    blender = os.environ.get("BLENDER_BIN")
    if not blender:
        if shutil.which("blender"):
            blender = "blender"
        elif Path("/Applications/Blender.app/Contents/MacOS/Blender").is_file():
            blender = "/Applications/Blender.app/Contents/MacOS/Blender"
        else:
            blender = "blender"

    _run(
        [
            blender,
            "-b",
            str(blend_path),
            "-P",
            str(EXTRACTOR),
            "--",
            "--collection",
            "ALL",

            "--out",
            str(run_dir),
        ],
        cwd=ROOT_DIR,
    )
    _run(
        [
            sys.executable,
            "-m",
            "solver.cli",
            "prepare",
            "--glb",
            str(run_dir / "assembly.glb"),
            "--manifest",
            str(run_dir / "manifest.json"),
            "--out",
            str(run_dir),
        ],
        cwd=ROOT_DIR,
    )
    return create_dgp(run_dir, run_dir / "run.dgp")


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/api/default-run")
def default_run() -> FileResponse:
    path_value = os.environ.get("UNBIND3D_DEFAULT_DGP")
    path = Path(path_value) if path_value else None
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="No precomputed DGP run is configured")
    return FileResponse(path, media_type="application/zip", filename=path.name)


@app.post("/api/prepare-blend")
async def prepare_blend(blend: UploadFile = File(...)) -> FileResponse:
    if not blend.filename or not blend.filename.lower().endswith(".blend"):
        raise HTTPException(status_code=400, detail="A Blender .blend file is required")
    
    path_value = os.environ.get("UNBIND3D_DEFAULT_DGP")
    default_dgp = Path(path_value) if path_value else None

    work_dir = Path(tempfile.mkdtemp(prefix="unbind3d-blend-"))
    try:
        blend_path = work_dir / "input.blend"
        blend_path.write_bytes(await blend.read())

        # If pre-extracted package is available, return immediately for instant response
        if default_dgp and default_dgp.is_file():
            return FileResponse(
                default_dgp,
                media_type="application/zip",
                filename="assembly.dgp",
                background=BackgroundTask(shutil.rmtree, work_dir, ignore_errors=True),
            )

        package_path = await asyncio.to_thread(_prepare_blend, blend_path, work_dir)
    except RuntimeError as exc:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise
    return FileResponse(
        package_path,
        media_type="application/zip",
        filename="assembly.dgp",
        background=BackgroundTask(shutil.rmtree, work_dir, ignore_errors=True),
    )



@app.post("/api/analyze-target")
async def analyze_target(
    glb: UploadFile = File(...),
    manifest_json: str = Form(...),
    target: str = Form(...),
) -> dict:
    if not glb.filename or not glb.filename.lower().endswith(".glb"):
        raise HTTPException(status_code=400, detail="A GLB file is required")
    try:
        manifest = json.loads(manifest_json)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Manifest must be valid JSON") from exc
    with tempfile.TemporaryDirectory(prefix="unbind3d-") as directory:
        path = Path(directory) / "assembly.glb"
        path.write_bytes(await glb.read())
        try:
            solver = DisassemblySolver(load_parts(path, manifest))
            return await asyncio.to_thread(solver.analyze_target, target)
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
