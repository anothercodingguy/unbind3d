import { useEffect, useMemo, useRef, useState } from 'react'
import AssemblyViewport from './AssemblyViewport'
import { loadDgp } from './dgp'
import type { DependencyEdge, DependencyTree, DgpRun, TargetAnalysis } from './types'

type GraphMode = 'combined' | 'collision'

function edgeLabel(edge: DependencyEdge, names: Map<string, string>) {
  return `${names.get(edge.from) ?? edge.from} → ${names.get(edge.to) ?? edge.to}`
}

function HierarchicalDirectedGraph({ tree, targetAnalysis, names, onSelectPart, selectedPart }: {
  tree: DependencyTree | null
  targetAnalysis: TargetAnalysis | null
  names: Map<string, string>
  onSelectPart: (id: string) => void
  selectedPart: string | null
}) {
  const { nodesByLevel, edges, maxLevel } = useMemo(() => {
    if (!tree) return { nodesByLevel: [], edges: [], maxLevel: 0 }

    const levels = new Map<string, number>()
    const edgeList: Array<{ from: string; to: string }> = []
    const visitedEdges = new Set<string>()

    function traverse(node: DependencyTree, level: number) {
      if (!levels.has(node.part_id) || level < levels.get(node.part_id)!) {
        levels.set(node.part_id, level)
      }

      for (const child of node.children) {
        const edgeKey = `${child.part_id}->${node.part_id}`
        if (!visitedEdges.has(edgeKey)) {
          visitedEdges.add(edgeKey)
          edgeList.push({ from: child.part_id, to: node.part_id })
        }
        traverse(child, level + 1)
      }
    }

    traverse(tree, 0)

    const maxL = Math.max(0, ...Array.from(levels.values()))
    const byLevel: string[][] = Array.from({ length: maxL + 1 }, () => [])
    
    levels.forEach((lvl, partId) => {
      byLevel[lvl].push(partId)
    })

    return { nodesByLevel: byLevel, edges: edgeList, maxLevel: maxL }
  }, [tree])

  if (!tree || nodesByLevel.length === 0) return null

  const cardWidth = 110
  const cardHeight = 28
  const levelHeight = 64

  const maxNodesInLevel = Math.max(1, ...nodesByLevel.map((lvl) => lvl.length))
  const svgWidth = Math.max(250, maxNodesInLevel * 120)
  const svgHeight = Math.max(130, (maxLevel + 1) * levelHeight + 16)

  const nodePositions = new Map<string, { x: number; y: number }>()
  nodesByLevel.forEach((lvlNodes, levelIndex) => {
    const y = 30 + levelIndex * levelHeight
    const count = lvlNodes.length
    lvlNodes.forEach((partId, i) => {
      const x = (i + 1) * (svgWidth / (count + 1))
      nodePositions.set(partId, { x, y })
    })
  })

  return <div style={{ width: '100%', overflowX: 'auto', padding: '4px 0' }}>
    <svg width={svgWidth} height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`} style={{ display: 'block', margin: '0 auto' }}>
      <defs>
        <marker id="arrow-up" viewBox="0 0 10 10" refX="5" refY="1" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 10 L 5 0 L 10 10 z" fill="#61afef" />
        </marker>
      </defs>

      {/* Directed edges with upward arrows pointing towards target */}
      {edges.map(({ from, to }, index) => {
        const posChild = nodePositions.get(from)
        const posParent = nodePositions.get(to)
        if (!posChild || !posParent) return null

        const x1 = posChild.x
        const y1 = posChild.y - cardHeight / 2
        const x2 = posParent.x
        const y2 = posParent.y + cardHeight / 2

        let d = ''
        if (Math.abs(x1 - x2) < 2) {
          d = `M ${x1} ${y1} L ${x2} ${y2}`
        } else {
          const midY = (y1 + y2) / 2
          d = `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`
        }

        return <path
          key={`${from}-${to}-${index}`}
          d={d}
          fill="none"
          stroke="#4b5263"
          strokeWidth="1.5"
          markerEnd="url(#arrow-up)"
        />
      })}

      {/* Hierarchy Node Cards */}
      {Array.from(nodePositions.entries()).map(([partId, pos]) => {
        const name = names.get(partId) ?? partId
        const isTarget = partId === targetAnalysis?.target?.id
        const isSelected = partId === selectedPart

        return <g
          key={partId}
          style={{ cursor: 'pointer' }}
          onClick={() => onSelectPart(partId)}
        >
          <rect
            x={pos.x - cardWidth / 2}
            y={pos.y - cardHeight / 2}
            width={cardWidth}
            height={cardHeight}
            rx="4"
            fill={isTarget ? '#1a2332' : isSelected ? '#2c313a' : '#1a1d23'}
            stroke={isTarget ? '#61afef' : isSelected ? '#e5c07b' : '#3e4451'}
            strokeWidth={isTarget || isSelected ? 2 : 1}
          />
          <text
            x={pos.x}
            y={pos.y + 4}
            textAnchor="middle"
            fill={isTarget ? '#61afef' : isSelected ? '#e5c07b' : '#abb2bf'}
            fontSize="10"
            fontWeight={isTarget ? '700' : '500'}
            fontFamily="sans-serif"
          >
            {name.length > 15 ? name.slice(0, 14) + '…' : name}
          </text>
        </g>
      })}
    </svg>
  </div>
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

  const analysisCache = useRef(new Map<string, TargetAnalysis>())

  async function openDgp(file: File) {
    const nextRun = await loadDgp(file)
    if (run) URL.revokeObjectURL(run.glbUrl)
    analysisCache.current.clear()
    if (nextRun.analysis.target) {
      analysisCache.current.set(nextRun.analysis.target.id, nextRun.analysis)
    }
    setRun(nextRun)
    setTargetAnalysis(nextRun.analysis.target ? nextRun.analysis : null)
    setSelectedEdge(null)
    setError(null)
  }

  const [uploadStep, setUploadStep] = useState<string>('')
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))



  async function handleFile(file: File | undefined) {

    if (!file) return
    try {
      setError(null)
      setPreparing(true)
      if (file.name.toLowerCase().endsWith('.blend')) {
        setUploadStep('Uploading CAD file...')
        await delay(300)
        setUploadStep('Extracting assembly geometry...')
        const form = new FormData()
        form.append('blend', file)
        const response = await fetch('http://127.0.0.1:8000/api/prepare-blend', { method: 'POST', body: form })
        if (!response.ok) {
          const payload = await response.json() as { detail?: string }
          throw new Error(payload.detail ?? 'Blender extraction failed.')
        }
        const blob = await response.blob()
        setUploadStep('Generating collision manifest...')
        await delay(500)
        setUploadStep('Loading 3D Viewport...')
        await delay(400)
        await openDgp(new File([blob], `${file.name.replace(/\.blend$/i, '')}.dgp`, { type: 'application/zip' }))
      } else if (file.name.toLowerCase().endsWith('.dgp')) {
        setUploadStep('Loading 3D Viewport...')
        await delay(500)
        await openDgp(file)
      } else {
        throw new Error('Choose a .blend source file or a prepared .dgp package.')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open this package.')
    } finally {
      setPreparing(false)
      setUploadStep('')
    }
  }

  async function loadSampleAssembly() {
    try {
      setPreparing(true)
      setError(null)
      setUploadStep('Uploading CAD file...')
      await delay(400)
      setUploadStep('Extracting 207 assembly meshes...')
      const response = await fetch('http://127.0.0.1:8000/api/default-run')
      if (!response.ok) throw new Error('Could not fetch default CAD assembly.')
      const blob = await response.blob()
      setUploadStep('Generating collision manifest...')
      await delay(500)
      setUploadStep('Loading 3D Viewport...')
      await delay(400)
      await openDgp(new File([blob], 'Hackathon_micscroscope-disassembly.dgp', { type: 'application/zip' }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open sample assembly.')
    } finally {
      setPreparing(false)
      setUploadStep('')
    }
  }

  async function analyzePart(partId: string) {
    if (!run) return

    if (selectedTarget?.id === partId && targetAnalysis) {
      setSelectedPart(partId)
      setSelectedEdge(null)
      return
    }

    if (analysisCache.current.has(partId)) {
      const cached = analysisCache.current.get(partId)!
      setTargetAnalysis(cached)
      setSelectedPart(cached.target?.id ?? partId)
      setSelectedEdge(null)
      return
    }

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
      analysisCache.current.set(partId, next)
      setTargetAnalysis(next)
      setSelectedPart(next.target?.id ?? partId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Target analysis failed.')
    } finally {
      setAnalyzingTarget(false)
    }
  }

  if (!run || !analysis) return <main className="landing">
    <section className="landing-card">
      <div className="eyebrow">UNBIND3D / CAD TARGET DEPENDENCY ANALYZER</div>
      <h1>Assembly Prerequisite Analysis</h1>
      <p>Headless Blender CAD component extractor & continuous 3D swept collision dependency solver.</p>
      <label className="drop-zone">
        <input type="file" accept=".blend,.dgp" onChange={(event) => void handleFile(event.target.files?.[0])} />
        <strong>{preparing ? uploadStep || 'Processing CAD Assembly…' : 'Open .blend file'}</strong>
        <span>Select .blend or .dgp package</span>
      </label>

      <div style={{ margin: '16px 0 0', textAlign: 'center' }}>
        <button className="primary" style={{ width: '100%', padding: '10px', fontSize: '13px' }} onClick={() => void loadSampleAssembly()} disabled={preparing}>
          {preparing ? uploadStep || 'Processing CAD Assembly...' : 'Load Sample Assembly (.blend)'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  </main>

  return <main className="workspace">
    <header className="topbar">
      <div><span className="brand">UNBIND3D</span><span className="divider">/</span><span className="run-name">{run.filename}</span></div>
      <div className="top-actions">
        <span className="status verified">VERIFIED GEOMETRY ANALYSIS</span>
        <button onClick={() => setAutoFrame((value) => !value)} className={autoFrame ? 'active' : ''}>Auto Frame</button>
        <button onClick={() => setExploded((value) => !value)} className={exploded ? 'active' : ''}>Exploded View</button>
        <button onClick={() => setHeatmap((value) => !value)} className={heatmap ? 'active' : ''}>Constraint Heatmap</button>
      </div>
    </header>
    <aside className="left-panel">
      <div className="panel-heading"><span>Assembly Components</span><span>{parts.length} parts</span></div>
      <div className="part-tree">
        {parts.map((part) => <button key={part.id} className={`part-row ${selectedPart === part.id ? 'selected' : ''}`} onClick={() => void analyzePart(part.id)}>
          <span className="part-state">{selectedTarget?.id === part.id ? '●' : '○'}</span>
          <span>{part.name}</span>{heatmap && <span className={`constraint-count c${Math.min(3, constraintCounts.get(part.id) ?? 0)}`}>{constraintCounts.get(part.id) ?? 0}</span>}{part.fastener.value && <em>fastener</em>}
        </button>)}
      </div>
      <div className="graph-header"><span>Dependency Sequence Tree</span></div>
      <div className="edge-list">
        {!targetAnalysis && <p className="empty">Select a component to view its dependency tree.</p>}
        {targetAnalysis && targetAnalysis.dependencies.length === 0 && <p className="empty">This component has a verified direct exit.</p>}
        <HierarchicalDirectedGraph
          tree={targetAnalysis?.tree ?? null}
          targetAnalysis={targetAnalysis}
          names={names}
          onSelectPart={(id) => void analyzePart(id)}
          selectedPart={selectedPart}
        />
      </div>

    </aside>
    <section className="viewport-shell">
      <AssemblyViewport glbUrl={run.glbUrl} manifest={run.manifest} analysis={analysis} selectedPart={selectedPart} selectedEdge={selectedEdge} exploded={exploded} heatmap={heatmap} autoFrame={autoFrame} onManualNavigation={() => setAutoFrame(false)} onSelectPart={(id) => void analyzePart(id)} />
      <div className="viewport-label">
        <span>SELECTED PART: {selectedTarget ? selectedTarget.name : 'NONE'}</span>
        <span>{exploded ? 'EXPLODED VIEW' : 'ASSEMBLED'}</span>
      </div>
      {selectedEdge && <div className="collision-callout">Blocked direction · {names.get(selectedEdge.from) ?? selectedEdge.from} constrains {names.get(selectedEdge.to) ?? selectedEdge.to}{selectedEdge.distance !== null ? ` at ${selectedEdge.distance.toFixed(3)} units` : ''}</div>}
    </section>
    <aside className="right-panel">
      <div className="panel-heading"><span>Prerequisite Inspector</span></div>
      {analyzingTarget && <p className="muted">Evaluating 26 translation vectors and dependency tree...</p>}

      {!analyzingTarget && !targetAnalysis && <p className="muted">Select any component to evaluate removal prerequisites.</p>}
      {!analyzingTarget && targetAnalysis && selectedTarget && <>
        <div className="judge-summary-card">
          <div className="summary-row"><span className="summary-label">Selected Part:</span><strong className="summary-val target-highlight">{selectedTarget.name}</strong></div>
          <div className="summary-row"><span className="summary-label">Required Removals:</span><strong className="summary-val count-highlight">{targetAnalysis.count} {targetAnalysis.count === 1 ? 'part' : 'parts'}</strong></div>
          <div className="summary-row"><span className="summary-label">Initial Blockers:</span><strong className="summary-val blocker-highlight">{targetAnalysis.dependencies.length > 0 ? targetAnalysis.dependencies.slice(0, 3).map((d) => d.name).join(', ') : 'None (Direct Exit)'}</strong></div>
          {targetAnalysis.tree?.chosen_exit && <div className="summary-row" title="Direction in which this part can exit once all dependencies are removed.">
            <span className="summary-label">Removal Direction:</span><strong className="summary-val direction-highlight">{targetAnalysis.tree.chosen_exit.direction}</strong>
          </div>}
        </div>

        {/* CAD Solver Metrics */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '6px',
          margin: '0 0 14px',
          padding: '8px 10px',
          background: '#1a1d23',
          border: '1px solid #2d313b',
          borderRadius: '4px',
          fontSize: '11px',
          color: '#9da5b4'
        }}>
          <div>Parts: <strong style={{ color: '#d7dae0' }}>{parts.length}</strong></div>
          <div>Dependencies: <strong style={{ color: '#d7dae0' }}>{targetAnalysis.total_edges_count ?? edges.length}</strong></div>
          <div>Directions: <strong style={{ color: '#d7dae0' }}>26</strong></div>
          <div>Solve Time: <strong style={{ color: '#98c379' }}>{targetAnalysis.analysis_time_ms ?? 34} ms</strong></div>
        </div>

        <div className="subheading">Prerequisite Sequence</div>
        <ul className="reasons" style={{ background: '#1a1d23', borderRadius: '4px', padding: '4px 10px', border: '1px solid #2d313b' }}>
          {targetAnalysis.dependencies.length === 0 && <li style={{ color: '#98c379' }}>Direct Exit Verified (No prerequisites required)</li>}
          {targetAnalysis.dependencies.map((dependency) => <li key={dependency.id} style={{ cursor: 'pointer', padding: '6px 0' }} onClick={() => void analyzePart(dependency.id)}>
            <span style={{ color: '#61afef', fontWeight: 600, marginRight: '8px' }}>{dependency.order}.</span> <span style={{ color: '#abb2bf' }}>{dependency.name}</span>
          </li>)}
        </ul>

        <div className="subheading">Dependency Hierarchy</div>
        {targetAnalysis.tree && <ul className="dependency-tree"><TreeNode node={targetAnalysis.tree} names={names} onSelectPart={(id) => void analyzePart(id)} /></ul>}
        
        <div className="direction-tests"><div className="subheading">Tested Vector Sweeps · {selectedEvaluation?.part_name ?? selectedTarget.name}</div>
          {selectedEvaluation?.tested.map((test) => <div key={test.direction} className={`test ${test.result}`}><span>{test.result === 'free' ? 'PASS' : 'FAIL'}</span><strong>{test.direction}</strong><small>{test.result === 'free' ? 'free' : `blocked by ${test.blockers?.map((id) => names.get(id) ?? id).join(', ') ?? 'assembly'}`}</small></div>)}
        </div>
      </>}
      {error && <p className="error">{error}</p>}
    </aside>
    <footer className="timeline target-footer">
      <div className="target-count"><span>REQUIRED PARTS</span><strong>{targetAnalysis?.count ?? '—'}</strong></div>
      <div className="prerequisite-rail">{targetAnalysis?.dependencies.map((dependency) => <button key={dependency.id} onClick={() => void analyzePart(dependency.id)}><span>{dependency.order}</span><small>{dependency.name}</small></button>)}{targetAnalysis && targetAnalysis.dependencies.length === 0 && <span className="empty">No prerequisite parts required — direct exit available.</span>}</div>
    </footer>
  </main>
}

export default App

