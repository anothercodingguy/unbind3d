import { Grid, Line, OrbitControls, useGLTF } from '@react-three/drei'
import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { Suspense, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { DependencyEdge, Manifest, TargetAnalysis, Vec3 } from './types'

type ViewportProps = {
  glbUrl: string
  manifest: Manifest
  analysis: TargetAnalysis
  selectedPart: string | null
  selectedEdge: DependencyEdge | null
  exploded: boolean
  heatmap: boolean
  autoFrame: boolean
  onManualNavigation: () => void
  onSelectPart: (id: string) => void
}

const asVector = (value: Vec3) => new THREE.Vector3(value[0], value[1], value[2])

function focusForPart(manifest: Manifest, analysis: TargetAnalysis, partId: string | null) {
  const manifestPart = manifest.parts.find((item) => item.part_id === partId)
  const analysisPart = analysis.parts.find((item) => item.id === partId)
  const bounds = manifestPart?.bounds ?? analysisPart?.bounds
  if (!bounds) return new THREE.Vector3(0, 0, 0)
  return asVector(bounds[0]).add(asVector(bounds[1])).multiplyScalar(0.5)
}

function CameraRig({ focus, enabled, controls }: { focus: THREE.Vector3; enabled: boolean; controls: React.RefObject<OrbitControlsImpl> }) {
  const { camera } = useThree()
  useFrame(() => {
    if (!enabled) return
    const desired = focus.clone().add(new THREE.Vector3(4.8, 4.1, 5.8))
    camera.position.lerp(desired, 0.07)
    controls.current?.target.lerp(focus, 0.09)
    controls.current?.update()
  })
  return null
}

function chosenExit(analysis: TargetAnalysis, partId: string | null) {
  const evaluation = analysis.node_evaluations.find((item) => item.part_id === partId)
  const locate = (node: TargetAnalysis['tree']): TargetAnalysis['tree'] | null => {
    if (!node) return null
    if (node.part_id === partId) return node
    for (const child of node.children) {
      const found = locate(child)
      if (found) return found
    }
    return null
  }
  return { evaluation, option: locate(analysis.tree)?.chosen_exit }
}

const BLENDER_WORKBENCH_COLORS = [
  '#7fa99b', // soft sage green
  '#8a7dbb', // lavender purple
  '#d68c68', // terracotta orange
  '#6b9080', // muted teal
  '#bfa66f', // warm sand / gold
  '#a36888', // dusty rose
  '#6fa6bb', // pastel blue
  '#93a368', // olive green
  '#ba7668', // warm clay
  '#849a68', // moss green
  '#9b76ba', // muted violet
  '#c29468', // soft amber
  '#68a3a8', // ocean blue
  '#aa7868', // brick pink
  '#748ba3', // slate blue
]

function partRandomColor(partId: string) {
  let hash = 0
  for (let i = 0; i < partId.length; i++) {
    hash = partId.charCodeAt(i) + ((hash << 5) - hash)
  }
  const index = Math.abs(hash) % BLENDER_WORKBENCH_COLORS.length
  return BLENDER_WORKBENCH_COLORS[index]
}

function Model({ glbUrl, manifest, analysis, selectedPart, selectedEdge, exploded, heatmap, onSelectPart }: Omit<ViewportProps, 'autoFrame' | 'onManualNavigation'>) {
  const { scene } = useGLTF(glbUrl)
  const model = useMemo(() => scene.clone(true), [scene])
  const originals = useRef(new Map<string, THREE.Vector3>())
  const partByNode = useMemo(() => new Map(manifest.parts.map((part) => [part.glb_node, part])), [manifest])
  const partForNode = (nodeName: string) => partByNode.get(nodeName) ?? manifest.parts.find((part) => nodeName.startsWith(`${part.glb_node}_`))
  const prerequisiteIds = useMemo(() => new Set(analysis.prerequisite_order), [analysis.prerequisite_order])
  const blockerCounts = useMemo(() => {
    const map = new Map<string, number>()
    analysis.dependency_graph.edges.filter((edge) => edge.required).forEach((edge) => map.set(edge.to, (map.get(edge.to) ?? 0) + 1))
    return map
  }, [analysis])

  useEffect(() => {
    model.traverse((object) => {
      const part = partForNode(object.name)
      if (!part) return
      if (!originals.current.has(part.part_id)) originals.current.set(part.part_id, object.position.clone())
      const base = originals.current.get(part.part_id)!.clone()
      const { option } = chosenExit(analysis, part.part_id)
      if (exploded && option && (part.part_id === analysis.target?.id || prerequisiteIds.has(part.part_id))) {
        base.addScaledVector(asVector(option.vector), Math.min(option.travel_distance * 0.12, 1.1))
      }
      object.position.copy(base)
      object.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return
        let material = child.material
        if (!(material instanceof THREE.MeshStandardMaterial)) {
          material = new THREE.MeshStandardMaterial()
          child.material = material
        }
        const stdMat = material as THREE.MeshStandardMaterial
        stdMat.roughness = 0.35
        stdMat.metalness = 0.08
        stdMat.transparent = true

        const isTarget = part.part_id === selectedPart
        const isPrerequisite = prerequisiteIds.has(part.part_id)
        const isEdgeSelected = selectedEdge && (part.part_id === selectedEdge.from || part.part_id === selectedEdge.to)
        const isDimmed = analysis.target && !isTarget && !isPrerequisite

        stdMat.opacity = isDimmed ? 0.30 : 1.0


        if (isTarget) {
          stdMat.color.set('#00e5ff')
          stdMat.emissive.set('#0088cc')
          stdMat.emissiveIntensity = 0.45
        } else if (isEdgeSelected) {
          stdMat.color.set('#ff4d4f')
          stdMat.emissive.set('#991111')
          stdMat.emissiveIntensity = 0.5
        } else if (isPrerequisite) {
          stdMat.color.set('#ffc107')
          stdMat.emissive.set('#886600')
          stdMat.emissiveIntensity = 0.35
        } else if (heatmap) {
          const count = blockerCounts.get(part.part_id) ?? 0
          const heatColor = count >= 4 ? '#ff3b30' : count >= 2 ? '#ff9500' : '#34c759'
          stdMat.color.set(heatColor)
          stdMat.emissive.set(heatColor)
          stdMat.emissiveIntensity = 0.25
        } else {
          // Blender Workbench Random Pastel Palette
          stdMat.color.set(partRandomColor(part.part_id))
          stdMat.emissive.set('#000000')
          stdMat.emissiveIntensity = 0.0
        }
      })
    })
  }, [model, analysis, selectedPart, selectedEdge, exploded, heatmap, prerequisiteIds, blockerCounts])

  const focusedPart = analysis.parts.find((part) => part.id === selectedPart)
  const { evaluation, option } = chosenExit(analysis, selectedPart)
  const origin = focusedPart ? asVector(focusedPart.bounds[0]).add(asVector(focusedPart.bounds[1])).multiplyScalar(0.5) : null
  const displayDistance = option && focusedPart ? Math.min(option.travel_distance, Math.max(...focusedPart.bounds[1].map((value, index) => value - focusedPart.bounds[0][index])) * 5) : 0
  const vector = option ? asVector(option.vector).normalize() : null
  const directionEnd = origin && vector ? origin.clone().addScaledVector(vector, displayDistance) : null
  const failedTest = selectedEdge && evaluation?.tested.find((test) => test.direction === selectedEdge.direction)
  const failedVector = failedTest ? asVector(failedTest.vector).normalize() : vector
  const failedEnd = origin && failedVector && failedTest ? origin.clone().addScaledVector(failedVector, Math.min(failedTest.travel_distance, displayDistance || failedTest.travel_distance)) : null
  const contact = selectedEdge?.contact?.[0]

  return <>
    <primitive object={model} onClick={(event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation()
      let current: THREE.Object3D | null = event.object
      while (current) {
        const part = partForNode(current.name)
        if (part) { onSelectPart(part.part_id); break }
        current = current.parent
      }
    }} />
    {origin && directionEnd && !exploded && <>
      <Line points={[origin, directionEnd]} color="#00e5ff" lineWidth={3} transparent opacity={0.95} />
      <arrowHelper args={[vector!, origin, displayDistance, '#00e5ff', 0.22, 0.11]} />
    </>}
    {selectedEdge && origin && failedEnd && <>
      <Line points={[origin, failedEnd]} color="#ff4d4f" lineWidth={3} dashed dashSize={0.08} gapSize={0.04} />
      {contact && <mesh position={contact.point}><sphereGeometry args={[0.07, 20, 20]} /><meshBasicMaterial color="#ff4d4f" /></mesh>}
    </>}
  </>
}

function ViewportScene(props: ViewportProps) {
  const controls = useRef<OrbitControlsImpl>(null)
  const focus = focusForPart(props.manifest, props.analysis, props.selectedPart ?? props.analysis.target?.id ?? null)
  return <>
    <color attach="background" args={['#282b30']} />
    <hemisphereLight intensity={0.95} color="#ffffff" groundColor="#333842" />
    <ambientLight intensity={0.7} />
    <directionalLight position={[10, 15, 10]} intensity={1.8} castShadow />
    <directionalLight position={[-10, 8, -10]} intensity={0.9} />
    <directionalLight position={[0, -10, 5]} intensity={0.4} />

    {/* Blender X (Red), Y (Green), Z (Blue) Axis Lines */}
    <Line points={[[-60, 0, 0], [60, 0, 0]]} color="#ff3b30" lineWidth={2} transparent opacity={0.75} />
    <Line points={[[0, 0, -60], [0, 0, 60]]} color="#34c759" lineWidth={2} transparent opacity={0.75} />
    <Line points={[[0, -60, 0], [0, 60, 0]]} color="#007aff" lineWidth={2} transparent opacity={0.65} />

    {/* Blender Dual Scale Grid */}
    <Grid args={[40, 40]} cellSize={0.25} cellThickness={0.4} cellColor="#3c434f" sectionSize={1.0} sectionThickness={1.2} sectionColor="#647185" fadeDistance={40} fadeStrength={1.2} infiniteGrid />

    <Suspense fallback={null}><Model {...props} /></Suspense>
    <CameraRig focus={focus} enabled={props.autoFrame} controls={controls} />
    <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.08} onStart={props.onManualNavigation} />
  </>
}

export default function AssemblyViewport(props: ViewportProps) {
  const selectedPartObj = props.analysis.parts.find((part) => part.id === props.selectedPart)
  const extent = selectedPartObj ? selectedPartObj.bounds[1].map((v, i) => (v - selectedPartObj.bounds[0][i])) : null

  return <div style={{ width: '100%', height: '100%', position: 'relative' }}>
    <Canvas shadows camera={{ position: [5, 4, 6], fov: 42 }} dpr={[1, 2]}>
      <ViewportScene {...props} />
    </Canvas>

    {/* Tiny Color Legend Overlay */}
    <div style={{
      position: 'absolute',
      bottom: '14px',
      left: '14px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      pointerEvents: 'none',
      background: 'rgba(28, 32, 39, 0.88)',
      border: '1px solid #4a5462',
      borderRadius: '6px',
      padding: '6px 12px',
      fontSize: '11px',
      color: '#d0dbe6',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      backdropFilter: 'blur(4px)'
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: '9px', height: '9px', borderRadius: '50%', background: '#00e5ff', display: 'inline-block' }}></span> <strong>Selected Part</strong></span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: '9px', height: '9px', borderRadius: '50%', background: '#ffc107', display: 'inline-block' }}></span> <strong>Dependencies</strong></span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: '9px', height: '9px', borderRadius: '50%', background: '#7fa99b', display: 'inline-block' }}></span> <strong>Assembly Parts</strong></span>
    </div>

    {/* Blender Viewport Axis Legend & Scale Overlay */}
    <div style={{
      position: 'absolute',
      bottom: '14px',
      right: '14px',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      pointerEvents: 'none',
      background: 'rgba(28, 32, 39, 0.85)',
      border: '1px solid #4a5462',
      borderRadius: '6px',
      padding: '8px 12px',
      fontSize: '11px',
      color: '#c2d1e0',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      backdropFilter: 'blur(4px)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', letterSpacing: '0.06em', color: '#8fa4b8' }}>
        <span>AXES:</span>
        <span style={{ color: '#ff4d4d', fontWeight: 'bold' }}>X (Red)</span>
        <span style={{ color: '#40d968', fontWeight: 'bold' }}>Y (Green)</span>
        <span style={{ color: '#409eff', fontWeight: 'bold' }}>Z (Blue)</span>
      </div>
      <div style={{ display: 'flex', gap: '12px', marginTop: '2px' }}>
        <span>GRID SCALE: <strong style={{ color: '#ffffff' }}>1.00m / 1000mm</strong></span>
        <span>SUBDIVISION: <strong style={{ color: '#ffffff' }}>0.25m / 250mm</strong></span>
      </div>
      {extent && <div style={{ fontSize: '10px', color: '#00e5ff', marginTop: '2px', borderTop: '1px solid #364150', paddingTop: '4px' }}>
        PART DIMENSIONS: <strong>{(extent[0] * 1000).toFixed(0)} × {(extent[1] * 1000).toFixed(0)} × {(extent[2] * 1000).toFixed(0)} mm</strong>
      </div>}
    </div>
  </div>
}



