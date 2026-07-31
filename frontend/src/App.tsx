import { useEffect, useMemo, useRef, useState } from 'react'
import AssemblyViewport from './AssemblyViewport'
import { loadDgp } from './dgp'
import type { DependencyEdge, DependencyTree, DgpRun, TargetAnalysis } from './types'

type GraphMode = 'combined' | 'collision'

function edgeLabel(edge: DependencyEdge, names: Map<string, string>) {
  return `${names.get(edge.from) ?? edge.from} → ${names.get(edge.to) ?? edge.to}`
}

function DependencyGraph({ edges, names, selectedEdge, onSelectEdge, onSelectPart }: {
  edges: DependencyEdge[]
  names: Map<string, string>
  selectedEdge: DependencyEdge | null
  onSelectEdge: (edge: DependencyEdge) => void
  onSelectPart: (id: string) => void
}) {
  const nodes = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))]
  if (!nodes.length) return null
  const positions = new Map(nodes.map((id, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / nodes.length
    return [id, { x: 120 + Math.cos(angle) * 75, y: 86 + Math.sin(angle) * 52 }]
  }))
  const label = (id: string) => (names.get(id) ?? id).slice(0, 13)
  return <svg className="dependency-graph" viewBox="0 0 240 172" aria-label="Interactive target dependency graph">
    <defs><marker id="arrow-collision" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#ff756c" /></marker></defs>
    {edges.map((edge, index) => {
      const from = positions.get(edge.from)!, to = positions.get(edge.to)!
      const selected = edge === selectedEdge
      return <line key={`${edge.from}-${edge.to}-${edge.direction}-${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={edge.required ? '#ff756c' : '#765050'} strokeOpacity={edge.required ? 1 : .42} strokeWidth={selected ? 3 : edge.required ? 2 : 1} strokeDasharray={edge.required ? undefined : '3 3'} markerEnd="url(#arrow-collision)" onClick={() => onSelectEdge(edge)} />
    })}
    {nodes.map((id) => {
      const point = positions.get(id)!
      return <g key={id} className="graph-node" onClick={() => onSelectPart(id)}><circle cx={point.x} cy={point.y} r="18" /><text x={point.x} y={point.y + 31} textAnchor="middle">{label(id)}</text></g>
    })}
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

  useEffect(() => {
    if (attemptedDefaultRun.current) return
    attemptedDefaultRun.current = true
    void (async () => {
      try {
        const response = await fetch('http://127.0.0.1:8000/api/default-run')
        if (response.status === 404) return
        if (!response.ok) throw new Error('Could not open the prepared assembly.')
        await openDgp(new File([await response.blob()], 'assembly.dgp', { type: 'application/zip' }))
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not open the prepared assembly.')
      }
    })()
  }, [])

  if (!run || !analysis) return <main className="landing">
    <section className="landing-card">
      <div className="eyebrow">UNBIND3D / TARGET DEPENDENCY ANALYSIS</div>
      <h1>Ask one part how to get out.</h1>
      <p>Drop the supplied <code>.blend</code>. Blender extracts the assembly once; then select the part whose removal prerequisites you want to inspect.</p>
      <label className="drop-zone">
        <input type="file" accept=".blend,.dgp" onChange={(event) => void handleFile(event.target.files?.[0])} />
        <strong>{preparing ? 'Extracting Blender assembly…' : 'Open .blend file'}</strong><span>Prepared DGP packages can also be reopened</span>
      </label>
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
      <div className="graph-header"><span>Target graph</span><div className="segmented">
        {(['combined', 'collision'] as GraphMode[]).map((mode) => <button key={mode} className={graphMode === mode ? 'active' : ''} onClick={() => setGraphMode(mode)}>{mode === 'combined' ? 'All' : 'Collision'}</button>)}
      </div></div>
      <div className="edge-list">
        {!targetAnalysis && <p className="empty">Select a target part to build its dependency graph.</p>}
        {targetAnalysis && edges.length === 0 && <p className="empty">This target has a verified direct exit.</p>}
        <DependencyGraph edges={edges} names={names} selectedEdge={selectedEdge} onSelectEdge={(edge) => { setSelectedEdge(edge); setSelectedPart(edge.to) }} onSelectPart={(id) => void analyzePart(id)} />
        {edges.map((edge, index) => <button key={`${edge.from}-${edge.to}-${edge.direction}-${index}`} className={`edge ${selectedEdge === edge ? 'selected' : 'collision'}`} onClick={() => { setSelectedEdge(edge); setSelectedPart(edge.to) }}>
          <span className="edge-type">⊗</span><span>{edgeLabel(edge, names)}</span><small>{edge.required ? `required exit constraint · ${edge.direction}` : `alternative path · ${edge.direction}`}</small>
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
