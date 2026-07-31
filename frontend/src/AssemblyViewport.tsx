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

  const originalMaterials = useRef(new Map<THREE.Mesh, { color: THREE.Color; roughness: number; metalness: number }>())

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
          return
        }
        const stdMat = material as THREE.MeshStandardMaterial
        if (!originalMaterials.current.has(child)) {
          originalMaterials.current.set(child, {
            color: stdMat.color.clone(),
            roughness: stdMat.roughness,
            metalness: stdMat.metalness,
          })
        }
        const orig = originalMaterials.current.get(child)!
        stdMat.transparent = true

        const isTarget = part.part_id === selectedPart
        const isPrerequisite = prerequisiteIds.has(part.part_id)
        const isEdgeSelected = selectedEdge && (part.part_id === selectedEdge.from || part.part_id === selectedEdge.to)
        const isDimmed = analysis.target && !isTarget && !isPrerequisite

        stdMat.opacity = isDimmed ? 0.35 : 1.0

        if (isTarget) {
          stdMat.color.set('#00e5ff')
          stdMat.emissive.set('#0088cc')
          stdMat.emissiveIntensity = 0.45
        } else if (isEdgeSelected) {
          stdMat.color.set('#e06c75')
          stdMat.emissive.set('#991111')
          stdMat.emissiveIntensity = 0.5
        } else if (isPrerequisite) {
          stdMat.color.set('#ffc107')
          stdMat.emissive.set('#886600')
          stdMat.emissiveIntensity = 0.35
        } else if (heatmap) {
          const count = blockerCounts.get(part.part_id) ?? 0
          const heatColor = count >= 4 ? '#e06c75' : count >= 2 ? '#e5c07b' : '#98c379'
          stdMat.color.set(heatColor)
          stdMat.emissive.set(heatColor)
          stdMat.emissiveIntensity = 0.25
        } else {
          // Restore exact original CAD model material color, roughness, and metalness
          stdMat.color.copy(orig.color)
          stdMat.roughness = orig.roughness
          stdMat.metalness = orig.metalness
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

    {/* Minimal CAD Legend Overlay */}
    <div style={{
      position: 'absolute',
      bottom: '12px',
      left: '12px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      pointerEvents: 'none',
      background: '#1a1d23',
      border: '1px solid #2d313b',
      borderRadius: '3px',
      padding: '5px 10px',
      fontSize: '10px',
      fontFamily: 'monospace',
      color: '#abb2bf'
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: '8px', height: '8px', background: '#00e5ff', display: 'inline-block' }}></span> Target</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: '8px', height: '8px', background: '#ffc107', display: 'inline-block' }}></span> Prerequisites</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: '8px', height: '8px', background: '#7fa99b', display: 'inline-block' }}></span> Assembly</span>
    </div>

    {/* Clean Engineering Axis & Scale Overlay */}
    <div style={{
      position: 'absolute',
      bottom: '12px',
      right: '12px',
      display: 'flex',
      flexDirection: 'column',
      gap: '3px',
      pointerEvents: 'none',
      background: '#1a1d23',
      border: '1px solid #2d313b',
      borderRadius: '3px',
      padding: '6px 10px',
      fontSize: '10px',
      fontFamily: 'monospace',
      color: '#abb2bf'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', letterSpacing: '0.04em' }}>
        <span>AXES:</span>
        <span style={{ color: '#e06c75', fontWeight: 'bold' }}>X</span>
        <span style={{ color: '#98c379', fontWeight: 'bold' }}>Y</span>
        <span style={{ color: '#61afef', fontWeight: 'bold' }}>Z</span>
      </div>
      <div style={{ display: 'flex', gap: '10px' }}>
        <span>GRID: <strong>1.00m</strong></span>
        <span>SUBDIV: <strong>0.25m</strong></span>
      </div>
      {extent && <div style={{ color: '#00e5ff', borderTop: '1px solid #2d313b', paddingTop: '3px' }}>
        BOUNDS: <strong>{(extent[0] * 1000).toFixed(0)} × {(extent[1] * 1000).toFixed(0)} × {(extent[2] * 1000).toFixed(0)} mm</strong>
      </div>}
    </div>
  </div>
}




