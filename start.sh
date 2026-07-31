#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT_PATH="${1:-}"
RUN_DIR="$ROOT_DIR/run"
DEFAULT_DGP=""
if [[ -n "${PYTHON_BIN:-}" ]]; then
  PYTHON_BIN="$PYTHON_BIN"
elif [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
else
  PYTHON_BIN="python3"
fi
if [[ -z "${PNPM_BIN:-}" ]]; then
  if command -v pnpm &>/dev/null; then
    PNPM_BIN="pnpm"
  else
    PNPM_BIN="npx pnpm"
  fi
fi

if [[ -z "${BLENDER_BIN:-}" ]]; then
  if command -v blender &>/dev/null; then
    BLENDER_BIN="blender"
  elif [[ -x "/Applications/Blender.app/Contents/MacOS/Blender" ]]; then
    BLENDER_BIN="/Applications/Blender.app/Contents/MacOS/Blender"
  else
    BLENDER_BIN="blender"
  fi
fi


mkdir -p "$RUN_DIR"
if [[ -z "$INPUT_PATH" ]]; then
  echo "Ready for a .blend upload in the local viewer."
elif [[ "$INPUT_PATH" == *.blend ]]; then
  "$BLENDER_BIN" -b "$INPUT_PATH" -P "$ROOT_DIR/blender/extract_microscope.py" -- \
    --collection ALL --out "$RUN_DIR"

  "$PYTHON_BIN" -m solver.cli prepare --glb "$RUN_DIR/assembly.glb" --manifest "$RUN_DIR/manifest.json" --out "$RUN_DIR"
  "$PYTHON_BIN" -m solver.cli pack --run-dir "$RUN_DIR" --out "$RUN_DIR/run.dgp"
  echo "Created $RUN_DIR/run.dgp"
  DEFAULT_DGP="$RUN_DIR/run.dgp"
elif [[ "$INPUT_PATH" == *.dgp ]]; then
  echo "Opening existing package in the viewer: $INPUT_PATH"
  DEFAULT_DGP="$(cd "$(dirname "$INPUT_PATH")" && pwd)/$(basename "$INPUT_PATH")"
else
  echo "Input must be a .blend or .dgp file" >&2
  exit 64
fi

cd "$ROOT_DIR"
UNBIND3D_DEFAULT_DGP="$DEFAULT_DGP" "$PYTHON_BIN" -m uvicorn solver.server:app --host 127.0.0.1 --port 8000 &
API_PID=$!
cleanup() { kill "$API_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
$PNPM_BIN --dir frontend dev --host 127.0.0.1

