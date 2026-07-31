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
  removedPartIds?: Set<string>
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

function Model({ glbUrl, manifest, analysis, selectedPart, selectedEdge, exploded, heatmap, removedPartIds, onSelectPart }: Omit<ViewportProps, 'autoFrame' | 'onManualNavigation'>) {
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
      const isRemoved = removedPartIds?.has(part.part_id) ?? false
      object.visible = !isRemoved
      if (isRemoved) return

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

        stdMat.opacity = isDimmed ? 0.22 : 1.0

        if (isTarget) {
          stdMat.color.set('#00ffff')
          stdMat.emissive.set('#00c8ff')
          stdMat.emissiveIntensity = 0.85
          stdMat.roughness = 0.15
          stdMat.metalness = 0.05
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
  }, [model, analysis, selectedPart, selectedEdge, exploded, heatmap, prerequisiteIds, blockerCounts, removedPartIds])





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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) return
      if (!controls.current) return

      const stepAngle = 0.08
      const panStep = 0.25

      if (e.key === 'ArrowLeft') {
        if (e.shiftKey) {
          controls.current.target.x -= panStep
        } else {
          const azimuthal = controls.current.getAzimuthalAngle()
          controls.current.setAzimuthalAngle(azimuthal - stepAngle)
        }
        controls.current.update()
        props.onManualNavigation()
      } else if (e.key === 'ArrowRight') {
        if (e.shiftKey) {
          controls.current.target.x += panStep
        } else {
          const azimuthal = controls.current.getAzimuthalAngle()
          controls.current.setAzimuthalAngle(azimuthal + stepAngle)
        }
        controls.current.update()
        props.onManualNavigation()
      } else if (e.key === 'ArrowUp') {
        if (e.shiftKey) {
          controls.current.target.y += panStep
        } else {
          const polar = controls.current.getPolarAngle()
          controls.current.setPolarAngle(Math.max(0.1, polar - stepAngle))
        }
        controls.current.update()
        props.onManualNavigation()
      } else if (e.key === 'ArrowDown') {
        if (e.shiftKey) {
          controls.current.target.y -= panStep
        } else {
          const polar = controls.current.getPolarAngle()
          controls.current.setPolarAngle(Math.min(Math.PI - 0.1, polar + stepAngle))
        }
        controls.current.update()
        props.onManualNavigation()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [props.onManualNavigation])

  return <>
    <color attach="background" args={['#1e2228']} />
    <hemisphereLight intensity={1.1} color="#ffffff" groundColor="#2a2e37" />
    <ambientLight intensity={0.85} />
    <directionalLight position={[12, 16, 12]} intensity={2.0} castShadow />
    <directionalLight position={[-12, 10, -12]} intensity={1.0} />
    <directionalLight position={[0, -12, 6]} intensity={0.5} />

    <Suspense fallback={null}><Model {...props} /></Suspense>
    <CameraRig focus={focus} enabled={props.autoFrame} controls={controls} />
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      onStart={props.onManualNavigation}
    />

  </>
}


export default function AssemblyViewport(props: ViewportProps) {
  return <div style={{ width: '100%', height: '100%', position: 'relative' }}>
    <Canvas shadows camera={{ position: [5, 4, 6], fov: 42 }} dpr={[1, 2]}>
      <ViewportScene {...props} />
    </Canvas>
  </div>
}





