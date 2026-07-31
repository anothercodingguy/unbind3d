export type Vec3 = [number, number, number]

export interface ManifestPart {
  part_id: string
  source_name: string
  source_path: string
  glb_node: string
  parent: string | null
  order: number
  hierarchy_depth: number
  bounds: [Vec3, Vec3]
  triangle_count: number
}

export interface Manifest {
  schema_version: string
  source?: { blend?: string; collection?: string; blender_version?: string }
  parts: ManifestPart[]
}

export interface Contact {
  point: Vec3
  normal: Vec3
}

export interface TestedDirection {
  direction: string
  vector: Vec3
  result: 'free' | 'blocked'
  travel_distance: number
  verified: boolean
  by?: string
  blockers?: string[]
  time_of_impact?: number
  distance?: number
  contact?: Contact[]
  blocker_details?: Array<{ part_id: string; time_of_impact: number; distance: number; contact: Contact[] }>
}

export interface DependencyEdge {
  from: string
  to: string
  type: 'collision'
  reason: string
  direction: string
  contact: Contact[]
  distance: number | null
  time_of_impact?: number | null
  required: boolean
  verified: boolean
}

export interface AnalysisPart {
  id: string
  name: string
  node: string
  parent: string | null
  order: number
  hierarchy_depth: number
  bounds: [Vec3, Vec3]
  fastener: { value: boolean; reason: string | null }
}

export interface ExitOption {
  direction: string
  vector: Vec3
  travel_distance: number
  blockers: string[]
  free: boolean
  direction_rank: number
}

export interface NodeEvaluation {
  part_id: string
  part_name: string
  tested: TestedDirection[]
  exit_options: ExitOption[]
  removable_now: boolean
}

export interface DependencyTree {
  part_id: string
  cycle: boolean
  chosen_exit?: ExitOption
  children: DependencyTree[]
}

export interface DependencyRecord {
  id: string
  name: string
  order: number
  fastener: { value: boolean; reason: string | null }
}

export interface TargetAnalysis {
  schema_version: string
  mode: 'target_prerequisite_workspace' | 'target_prerequisite_analysis'
  engine: string
  verified: boolean
  analysis_time_ms?: number
  total_edges_count?: number
  parts: AnalysisPart[]

  target: AnalysisPart | null
  dependencies: DependencyRecord[]
  prerequisite_order: string[]
  count: number
  dependency_graph: { nodes: string[]; edges: DependencyEdge[]; evidence: DependencyEdge[] }
  node_evaluations: NodeEvaluation[]
  tree: DependencyTree | null
  unresolved: { reason: string; target: string } | null
}

export interface DgpRun {
  glbUrl: string
  glbFile: File
  manifest: Manifest
  analysis: TargetAnalysis
  filename: string
}
