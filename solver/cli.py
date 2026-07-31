"""CLI for target-scoped disassembly dependency analysis and DGP packaging."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from .geometry import load_parts
from .package import create_dgp
from .planner import DisassemblySolver, SolverConfig


def _solver(glb: Path, manifest: Path, allow_aabb_fallback: bool) -> DisassemblySolver:
    manifest_data = json.loads(manifest.read_text())
    return DisassemblySolver(load_parts(glb, manifest_data), SolverConfig(allow_aabb_fallback=allow_aabb_fallback))


def _copy_artifacts(glb: Path, manifest: Path, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    output_glb, output_manifest = output / "assembly.glb", output / "manifest.json"
    if glb.resolve() != output_glb.resolve():
        shutil.copy2(glb, output_glb)
    if manifest.resolve() != output_manifest.resolve():
        shutil.copy2(manifest, output_manifest)


def command_prepare(args: argparse.Namespace) -> None:
    output = Path(args.out)
    glb, manifest = Path(args.glb), Path(args.manifest)
    solver = _solver(glb, manifest, args.allow_aabb_fallback)
    _copy_artifacts(glb, manifest, output)
    (output / "plan.json").write_text(json.dumps(solver.workspace(), indent=2))
    print(json.dumps({"workspace": str(output / "plan.json"), "parts": len(solver.parts)}, indent=2))


def command_analyze(args: argparse.Namespace) -> None:
    output = Path(args.out)
    glb, manifest = Path(args.glb), Path(args.manifest)
    solver = _solver(glb, manifest, args.allow_aabb_fallback)
    analysis = solver.analyze_target(args.target)
    _copy_artifacts(glb, manifest, output)
    (output / "plan.json").write_text(json.dumps(analysis, indent=2))
    print(json.dumps({"analysis": str(output / "plan.json"), "target": analysis["target"]["name"], "count": analysis["count"]}, indent=2))


def command_pack(args: argparse.Namespace) -> None:
    target = create_dgp(args.run_dir, args.out)
    print(target)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="unbind3d")
    sub = result.add_subparsers(required=True)
    for name, handler in (("prepare", command_prepare), ("analyze", command_analyze)):
        item = sub.add_parser(name)
        item.add_argument("--glb", required=True)
        item.add_argument("--manifest", required=True)
        item.add_argument("--out", required=True)
        if name == "analyze":
            item.add_argument("--target", required=True, help="part ID, Blender source name, or GLB node")
        item.add_argument("--allow-aabb-fallback", action="store_true")
        item.set_defaults(func=handler)
    package = sub.add_parser("pack")
    package.add_argument("--run-dir", required=True)
    package.add_argument("--out", required=True)
    package.set_defaults(func=command_pack)
    return result


def main() -> None:
    args = parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
