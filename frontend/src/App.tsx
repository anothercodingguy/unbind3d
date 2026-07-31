import { useEffect, useMemo, useRef, useState } from 'react'
import AssemblyViewport from './AssemblyViewport'
import { loadDgp } from './dgp'
import type { DependencyEdge, DependencyTree, DgpRun, TargetAnalysis } from './types'

type GraphMode = 'combined' | 'collision'

function edgeLabel(edge: DependencyEdge, names: Map<string, string>) {
  return `${names.get(edge.from) ?? edge.from} → ${names.get(edge.to) ?? edge.to}`
}

function edgeConstraintLabel(edge: DependencyEdge) {
  if (!edge.required) return `Alternative path · ${edge.direction}`
  return `Blocks ${edge.direction} exit`
}

function DependencyGraph({ edges, names, targetId, selectedEdge, onSelectEdge, onSelectPart }: {
  edges: DependencyEdge[]
  names: Map<string, string>
  targetId: string | undefined
  selectedEdge: DependencyEdge | null
  onSelectEdge: (edge: DependencyEdge) => void
  onSelectPart: (id: string) => void
}) {
  // Build a layered top-down hierarchy: target at top, blockers layer below, their blockers below that
  const allNodes = [...new Set(edges.flatMap((e) => [e.from, e.to]))]
  if (!allNodes.length) return null

  // Assign layers: target = 0, direct blockers of target = 1, their blockers = 2...
  const layers = new Map<string, number>()
  const childrenOf = new Map<string, string[]>() // who blocks this node
  for (const e of edges) {
    if (!childrenOf.has(e.to)) childrenOf.set(e.to, [])
    childrenOf.get(e.to)!.push(e.from)
  }
  // BFS from target downward
  const bfsQueue: string[] = targetId && allNodes.includes(targetId) ? [targetId] : [allNodes[0]]
  layers.set(bfsQueue[0], 0)
  for (let qi = 0; qi < bfsQueue.length; qi++) {
    const current = bfsQueue[qi]
    const depth = layers.get(current)!
    for (const blocker of (childrenOf.get(current) ?? [])) {
      if (!layers.has(blocker)) {
        layers.set(blocker, depth + 1)
        bfsQueue.push(blocker)
      }
    }
  }

  // Group nodes by layer and compute X positions
  const maxLayer = Math.max(...[...layers.values()])
  const byLayer = new Map<number, string[]>()
  for (const [id, layer] of layers) {
    if (!byLayer.has(layer)) byLayer.set(layer, [])
    byLayer.get(layer)!.push(id)
  }

  const W = 240, ROW_H = 54, NODE_R = 14
  const svgH = Math.max(130, (maxLayer + 1) * ROW_H + 30)
  const positions = new Map<string, { x: number; y: number }>()
  for (const [layer, ids] of byLayer) {
    const y = 22 + layer * ROW_H
    const step = W / (ids.length + 1)
    ids.forEach((id, i) => positions.set(id, { x: step * (i + 1), y }))
  }

  const label = (id: string) => (names.get(id) ?? id).replace(/_/g, ' ').slice(0, 14)

  return <svg className="dependency-graph" viewBox={`0 0 ${W} ${svgH}`} aria-label="Blocker graph — arrows point toward the part that must be removed next">
    <defs>
      <marker id="arr-req" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M 0 1 L 9 5 L 0 9 z" fill="#ff756c" />
      </marker>
      <marker id="arr-opt" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M 0 1 L 9 5 L 0 9 z" fill="#5a4040" />
      </marker>
    </defs>
    {/* Edges — drawn from blocker up toward the part it blocks */}
    {edges.map((edge, index) => {
      const from = positions.get(edge.from), to = positions.get(edge.to)
      if (!from || !to) return null
      const selected = edge === selectedEdge
      // draw arrow from blocker (lower layer) up to blocked part (upper layer)
      const dx = to.x - from.x, dy = to.y - from.y
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      const ex = to.x - (dx / len) * (NODE_R + 3)
      const ey = to.y - (dy / len) * (NODE_R + 3)
      const sx = from.x + (dx / len) * (NODE_R + 3)
      const sy = from.y + (dy / len) * (NODE_R + 3)
      return <line
        key={`${edge.from}-${edge.to}-${edge.direction}-${index}`}
        x1={sx} y1={sy} x2={ex} y2={ey}
        stroke={edge.required ? (selected ? '#ff3b30' : '#ff756c') : '#5a4040'}
        strokeOpacity={edge.required ? 1 : 0.5}
        strokeWidth={selected ? 3 : edge.required ? 1.8 : 1}
        strokeDasharray={edge.required ? undefined : '4 3'}
        markerEnd={edge.required ? 'url(#arr-req)' : 'url(#arr-opt)'}
        style={{ cursor: 'pointer' }}
        onClick={() => onSelectEdge(edge)}
      >
        <title>{edgeConstraintLabel(edge)}</title>
      </line>
    })}
    {/* Edge direction badges */}
    {edges.map((edge, index) => {
      const from = positions.get(edge.from), to = positions.get(edge.to)
      if (!from || !to || !edge.required) return null
      const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2
      return <text key={`lbl-${index}`} x={mx} y={my - 3} textAnchor="middle" fontSize="8" fill="#ff9480" style={{ pointerEvents: 'none' }}>{edge.direction}</text>
    })}
    {/* Nodes */}
    {allNodes.map((id) => {
      const pt = positions.get(id)
      if (!pt) return null
      const isTarget = id === targetId
      return <g key={id} className="graph-node" onClick={() => onSelectPart(id)}>
        <circle cx={pt.x} cy={pt.y} r={NODE_R} fill={isTarget ? '#0a3d52' : '#152535'} stroke={isTarget ? '#00e5ff' : '#5f879f'} strokeWidth={isTarget ? 2 : 1} />
        {isTarget && <circle cx={pt.x} cy={pt.y} r={NODE_R + 4} fill="none" stroke="#00e5ff" strokeWidth="1" strokeOpacity="0.35" />}
        <text x={pt.x} y={pt.y + NODE_R + 11} textAnchor="middle" fontSize="7.5" fill={isTarget ? '#a0e8ff' : '#b9c9d8'} style={{ pointerEvents: 'none' }}>{label(id)}</text>
      </g>
    })}
    {/* Legend */}
    <text x="4" y={svgH - 4} fontSize="7" fill="#4a6070">↑ arrow = blocks removal of</text>
  </svg>
}

function TreeNode({ node, names, onSelectPart }: { node: DependencyTree; names: Map<string, string>; onSelectPart: (id: string) => void }) {
  return <li>
    <button className="tree-node" onClick={() => onSelectPart(node.part_id)}>{names.get(node.part_id) ?? node.part_id}{node.cycle && <em>cycle</em>}</button>
    {node.chosen_exit && <small>{node.chosen_exit.free ? `free ${node.chosen_exit.direction}` : `${node.chosen_exit.direction} after ${node.chosen_exit.blockers.length} blocker${node.chosen_exit.blockers.length === 1 ? '' : 's'}`}</small>}
    {node.children.length > 0 && <ul>{node.children.map((child, index) => <TreeNode key={`${child.part_id}-${index}`} node={child} names={names} onSelectPart={onSelectPart} />)}</ul>}
  </li>
}

function App() {
  const [run, setRun] = useState<DgpRun | null>(null)
  const [targetAnalysis, setTargetAnalysis] = useState<TargetAnalysis | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedPart, setSelectedPart] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<DependencyEdge | null>(null)
  const [graphMode, setGraphMode] = useState<GraphMode>('combined')
  const [exploded, setExploded] = useState(false)
  const [heatmap, setHeatmap] = useState(false)
  const [autoFrame, setAutoFrame] = useState(true)
  const [preparing, setPreparing] = useState(false)
  const [analyzingTarget, setAnalyzingTarget] = useState(false)
  const attemptedDefaultRun = useRef(false)

  const baseAnalysis = run?.analysis
  const analysis = targetAnalysis ?? baseAnalysis
  const parts = analysis?.parts ?? []
  const names = useMemo(() => new Map(parts.map((part) => [part.id, part.name])), [parts])
  const edges = useMemo(() => (targetAnalysis?.dependency_graph.edges ?? []).filter((edge) => graphMode === 'combined' || edge.type === graphMode), [targetAnalysis, graphMode])
  const selectedEvaluation = targetAnalysis?.node_evaluations.find((item) => item.part_id === selectedPart)
  const selectedTarget = targetAnalysis?.target
  const constraintCounts = useMemo(() => {
    const counts = new Map<string, number>()
    targetAnalysis?.dependency_graph.edges.filter((edge) => edge.required).forEach((edge) => counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1))
    return counts
  }, [targetAnalysis])

  async function openDgp(file: File) {
    const nextRun = await loadDgp(file)
    if (run) URL.revokeObjectURL(run.glbUrl)
    setRun(nextRun)
    setTargetAnalysis(nextRun.analysis.target ? nextRun.analysis : null)
    setSelectedPart(nextRun.analysis.target?.id ?? null)
    setSelectedEdge(null)
    setError(null)
  }

  async function handleFile(file: File | undefined) {
    if (!file) return
    try {
      setError(null)
      if (file.name.toLowerCase().endsWith('.blend')) {
        setPreparing(true)
        const form = new FormData()
        form.append('blend', file)
        const response = await fetch('http://127.0.0.1:8000/api/prepare-blend', { method: 'POST', body: form })
        if (!response.ok) {
          const payload = await response.json() as { detail?: string }
          throw new Error(payload.detail ?? 'Blender extraction failed.')
        }
        await openDgp(new File([await response.blob()], `${file.name.replace(/\.blend$/i, '')}.dgp`, { type: 'application/zip' }))
      } else if (file.name.toLowerCase().endsWith('.dgp')) {
        await openDgp(file)
      } else {
        throw new Error('Choose a .blend source file or a prepared .dgp package.')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open this package.')
    } finally {
      setPreparing(false)
    }
  }

  async function analyzePart(partId: string) {
    if (!run) return
    setSelectedPart(partId)
    setSelectedEdge(null)
    setAnalyzingTarget(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('glb', run.glbFile)
      form.append('manifest_json', JSON.stringify(run.manifest))
      form.append('target', partId)
      const response = await fetch('http://127.0.0.1:8000/api/analyze-target', { method: 'POST', body: form })
      const payload = await response.json() as TargetAnalysis | { detail: string }
      if (!response.ok) throw new Error((payload as { detail: string }).detail)
      const next = payload as TargetAnalysis
      setTargetAnalysis(next)
      setSelectedPart(next.target?.id ?? partId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Target analysis failed.')
    } finally {
      setAnalyzingTarget(false)
    }
  }

  async function loadSampleAssembly() {
    try {
      setPreparing(true)
      setError(null)
      const response = await fetch('http://127.0.0.1:8000/api/default-run')
      if (!response.ok) throw new Error('Could not fetch the default CAD assembly.')
      await openDgp(new File([await response.blob()], 'Hackathon_micscroscope-disassembly.dgp', { type: 'application/zip' }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open sample assembly.')
    } finally {
      setPreparing(false)
    }
  }

  if (!run || !analysis) return <main className="landing">
    <section className="landing-card">
      <div className="eyebrow">UNBIND3D / TARGET DEPENDENCY ANALYSIS</div>
      <h1>Ask one part how to get out.</h1>
      <p>Upload a CAD <code>.blend</code> file. Blender headlessly extracts the 3D assembly, geometry, and manifest; then select any part to analyze its exact removal prerequisites.</p>
      <label className="drop-zone">
        <input type="file" accept=".blend,.dgp" onChange={(event) => void handleFile(event.target.files?.[0])} />
        <strong>{preparing ? 'Extracting Blender assembly geometry…' : '📁 Choose / Drop .blend file'}</strong>
        <span>Upload your .blend file or prepared .dgp package</span>
      </label>

      <div style={{ margin: '18px 0 0', textAlign: 'center' }}>
        <button className="primary" style={{ width: '100%', padding: '12px', fontSize: '13px', fontWeight: 600 }} onClick={() => void loadSampleAssembly()} disabled={preparing}>
          {preparing ? 'Extracting Blender CAD Assembly...' : '⚡ Load Microscope CAD Assembly (.blend)'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  </main>


  return <main className="workspace">
    <header className="topbar">
      <div><span className="brand">UNBIND3D</span><span className="divider">/</span><span className="run-name">{run.filename}</span></div>
      <div className="top-actions">
        <span className={`status ${analysis.verified ? 'verified' : 'unverified'}`}>{analysis.verified ? '● VERIFIED FCL ANALYSIS' : '● DEVELOPMENT FALLBACK'}</span>
        <button onClick={() => setAutoFrame((value) => !value)} className={autoFrame ? 'active' : ''}>Auto frame</button>
        <button onClick={() => setExploded((value) => !value)} className={exploded ? 'active' : ''}>Exploded</button>
        <button onClick={() => setHeatmap((value) => !value)} className={heatmap ? 'active' : ''}>Constraint heatmap</button>
      </div>
    </header>
    <aside className="left-panel">
      <div className="panel-heading"><span>Assembly</span><span>{parts.length} parts</span></div>
      <div className="part-tree">
        {parts.map((part) => <button key={part.id} className={`part-row ${selectedPart === part.id ? 'selected' : ''}`} onClick={() => void analyzePart(part.id)}>
          <span className="part-state">{selectedTarget?.id === part.id ? '◎' : targetAnalysis?.prerequisite_order.includes(part.id) ? '○' : '●'}</span>
          <span>{part.name}</span>{heatmap && <span className={`constraint-count c${Math.min(3, constraintCounts.get(part.id) ?? 0)}`}>{constraintCounts.get(part.id) ?? 0}</span>}{part.fastener.value && <em>fastener</em>}
        </button>)}
      </div>
      <div className="graph-header"><span>Blocker Graph</span><div className="segmented">
        {(['combined', 'collision'] as GraphMode[]).map((mode) => <button key={mode} className={graphMode === mode ? 'active' : ''} onClick={() => setGraphMode(mode)}>{mode === 'combined' ? 'All' : 'Collision'}</button>)}
      </div></div>
      <div className="edge-list">
        {!targetAnalysis && <p className="empty">Select a target part — arrows will show what must be removed first.</p>}
        {targetAnalysis && edges.length === 0 && <p className="empty">This target has a verified direct exit — nothing blocks it.</p>}
        <DependencyGraph edges={edges} names={names} targetId={selectedTarget?.id} selectedEdge={selectedEdge} onSelectEdge={(edge) => { setSelectedEdge(edge); setSelectedPart(edge.to) }} onSelectPart={(id) => void analyzePart(id)} />
        {edges.map((edge, index) => <button key={`${edge.from}-${edge.to}-${edge.direction}-${index}`} className={`edge ${selectedEdge === edge ? 'selected' : 'collision'}`} onClick={() => { setSelectedEdge(edge); setSelectedPart(edge.to) }}>
          <span className="edge-type">⊗</span><span>{edgeLabel(edge, names)}</span><small>{edge.required ? `Blocks removal along ${edge.direction}` : `Optional path · ${edge.direction}`}</small>
        </button>)}
      </div>
    </aside>
    <section className="viewport-shell">
      <AssemblyViewport glbUrl={run.glbUrl} manifest={run.manifest} analysis={analysis} selectedPart={selectedPart} selectedEdge={selectedEdge} exploded={exploded} heatmap={heatmap} autoFrame={autoFrame} onManualNavigation={() => setAutoFrame(false)} onSelectPart={(id) => void analyzePart(id)} />
      <div className="viewport-label"><span>{selectedTarget ? `TARGET: ${selectedTarget.name}` : 'SELECT A TARGET PART'}</span><span>{exploded ? 'DEPENDENCY EXPLODED VIEW' : 'ASSEMBLED CONTACT STATE'}</span></div>
      {selectedEdge && <div className="collision-callout">Blocked direction · {names.get(selectedEdge.from) ?? selectedEdge.from} constrains {names.get(selectedEdge.to) ?? selectedEdge.to}{selectedEdge.distance !== null ? ` at ${selectedEdge.distance.toFixed(3)} units` : ''}</div>}
    </section>
    <aside className="right-panel">
      <div className="panel-heading"><span>Prerequisite inspector</span><span>{analyzingTarget ? 'ANALYZING' : selectedTarget ? `${targetAnalysis?.count ?? 0} REQUIRED` : 'AWAITING TARGET'}</span></div>
      {analyzingTarget && <p className="muted">Testing all 26 translations and recursively tracing only the blockers for this target…</p>}
      {!analyzingTarget && !targetAnalysis && <p className="muted">Click any assembly part to compute its dependency tree. Initial mating contacts are allowed to separate; only swept collisions become constraints.</p>}
      {!analyzingTarget && targetAnalysis && selectedTarget && <>
        <div className="judge-summary-card">
          <div className="summary-row"><span className="summary-check">✓</span><span className="summary-label">Target:</span><strong className="summary-val target-highlight">{selectedTarget.name}</strong></div>
          <div className="summary-row"><span className="summary-check">✓</span><span className="summary-label">Required removals:</span><strong className="summary-val count-highlight">{targetAnalysis.count}</strong></div>
          <div className="summary-row"><span className="summary-check">✓</span><span className="summary-label">First removable blockers:</span><strong className="summary-val blocker-highlight">{targetAnalysis.dependencies.length > 0 ? targetAnalysis.dependencies.slice(0, 3).map((d) => d.name).join(', ') : 'None (Direct Exit)'}</strong></div>
          {targetAnalysis.tree?.chosen_exit && <div className="summary-row"><span className="summary-check">✓</span><span className="summary-label">Verified exit direction:</span><strong className="summary-val direction-highlight">{targetAnalysis.tree.chosen_exit.direction}</strong></div>}
        </div>
        <p className="muted">{targetAnalysis.count === 0 ? 'No parts must be removed first. A translation is verified free.' : `${targetAnalysis.count} unique prerequisite part${targetAnalysis.count === 1 ? '' : 's'} must be removed before this target can exit.`}</p>
        <ul className="reasons">
          {targetAnalysis.dependencies.length === 0 && <li><b>✓</b> Direct exit available</li>}
          {targetAnalysis.dependencies.map((dependency) => <li key={dependency.id}><b>{dependency.order}.</b> {dependency.name}</li>)}
          {targetAnalysis.tree?.chosen_exit && <li><b>✓</b> Exit {targetAnalysis.tree.chosen_exit.direction} continuously tested</li>}
        </ul>
        <div className="subheading">Dependency tree</div>

        {targetAnalysis.tree && <ul className="dependency-tree"><TreeNode node={targetAnalysis.tree} names={names} onSelectPart={(id) => void analyzePart(id)} /></ul>}
        <div className="direction-tests"><div className="subheading">Tested directions · {selectedEvaluation?.part_name ?? selectedTarget.name}</div>
          {selectedEvaluation?.tested.map((test) => <div key={test.direction} className={`test ${test.result}`}><span>{test.result === 'free' ? '✓' : '×'}</span><strong>{test.direction}</strong><small>{test.result === 'free' ? 'free' : `blocked by ${test.blockers?.map((id) => names.get(id) ?? id).join(', ') ?? 'assembly'}`}</small></div>)}
        </div>
        {targetAnalysis.unresolved && <div className="validation invalid"><strong>Dependency cycle</strong><span>{targetAnalysis.unresolved.reason}. Select a different target or inspect the highlighted constraints.</span></div>}
      </>}
      {error && <p className="error">{error}</p>}
    </aside>
    <footer className="timeline target-footer">
      <div className="target-count"><span>PREREQUISITES</span><strong>{targetAnalysis?.count ?? '—'}</strong></div>
      <div className="prerequisite-rail">{targetAnalysis?.dependencies.map((dependency) => <button key={dependency.id} onClick={() => void analyzePart(dependency.id)}><span>{dependency.order}</span><small>{dependency.name}</small></button>)}{targetAnalysis && targetAnalysis.dependencies.length === 0 && <span className="empty">No prerequisite parts — target has a direct verified exit.</span>}</div>
    </footer>
  </main>
}

export default App
