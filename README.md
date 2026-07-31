# Unbind3D — Target Dependency Analyzer

Unbind3D answers one precise CAD question: **what must be removed before this
selected part can translate out of the assembly?** It does not create a global
disassembly sequence or guess a first removable part.

> **Core Principle:** The solver never guesses. Every prerequisite edge is
> backed by an actual continuous collision test.

## Demo Video

[![Unbind3D Demo](https://img.youtube.com/vi/25Nv-bE9aks/maxresdefault.jpg)](https://youtu.be/25Nv-bE9aks)

▶ **[Watch the demo on YouTube](https://youtu.be/25Nv-bE9aks)**


## How it works

1. Blender headlessly extracts `Microscope_circuit` into `assembly.glb` and
   `manifest.json`.
2. The viewer asks the user to select a target part.
3. Python tests the selected target in all 26 translation directions. Initial
   mating-face contact is permitted to separate; only a swept mesh collision
   creates a blocker.
4. For every blocking part, the solver repeats the same target-scoped test,
   chooses the smallest deterministic prerequisite branch, and returns a
   dependency tree and leaf-first prerequisite list.
5. The React viewer highlights the target, required parts, alternative blocked
   directions, collision points, and the recursive tree.

## Run with only the supplied `.blend`

Requirements: Blender 4.5+, Python 3.11+, Node 20+, and pnpm. FCL is used for
certified continuous triangle-mesh collision checks.

```bash
python3 -m pip install -r requirements.txt
pnpm --dir frontend install
chmod +x start.sh

# macOS Blender application example
BLENDER_BIN="/Applications/Blender.app/Contents/MacOS/Blender" \
  ./start.sh /path/to/Hackathon_micscroscope-disassembly.blend
```

This creates `run/assembly.glb`, `run/manifest.json`, a target-neutral
`run/plan.json`, and `run/run.dgp`, then opens the viewer. Click a part in the
assembly list or 3D viewport to run its target analysis.

To start empty and upload the `.blend` through the browser:

```bash
./start.sh
```

To reopen an extracted DGP package without Blender:

```bash
./start.sh run/run.dgp
```

## CLI and API

```bash
# Extract only (requires Blender)
blender -b input.blend -P blender/extract_microscope.py -- \
  --collection Microscope_circuit --out run

# Prepare a target-neutral DGP workspace
python3 -m solver.cli prepare --glb run/assembly.glb --manifest run/manifest.json --out run

# Analyze one selected target by part ID, Blender name, or GLB node
python3 -m solver.cli analyze --glb run/assembly.glb --manifest run/manifest.json \
  --target "Tray" --out run/target-tray
```

The local viewer uses `POST /api/analyze-target` with the GLB, manifest, and
target ID. Its response has the requested shape:

```json
{
  "target": {"id": "tray", "name": "Tray"},
  "dependencies": [{"id": "screw_01", "name": "Screw_01", "order": 1}],
  "count": 1
}
```

It also includes all tested directions, complete edge metadata, the chosen
exit option for every visited node, and a recursive `tree` for explainability.

## Scope and guarantees

- Translation-only motion: ±X, ±Y, ±Z, edge diagonals, and corner diagonals.
- Each Blender mesh object is one part; lights, cameras, and empties are not
  analyzed.
- The solver records all blockers for every tested direction. Edges belonging
  to the selected minimum prerequisite branch are marked `required: true`;
  alternate blocked exits remain visible as dashed evidence.
- Fastener detection is display metadata only. It never creates a dependency.
- Cyclic target dependencies are reported rather than guessed.

## Package format

`run.dgp` is a ZIP package:

```text
dgp.json              # format/version and FCL capability
assembly.glb           # rendered geometry
manifest.json          # Blender-to-GLB identity mapping
plan.json              # target-neutral workspace or one target analysis
```

## Tests

```bash
pytest -q
pnpm --dir frontend build
```
