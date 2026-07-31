import JSZip from 'jszip'
import type { DgpRun, Manifest, TargetAnalysis } from './types'

export async function loadDgp(file: File): Promise<DgpRun> {
  const archive = await JSZip.loadAsync(file)
  const [descriptor, model, manifestFile, planFile] = await Promise.all([
    archive.file('dgp.json')?.async('string'),
    archive.file('assembly.glb')?.async('blob'),
    archive.file('manifest.json')?.async('string'),
    archive.file('plan.json')?.async('string'),
  ])
  if (!descriptor || !model || !manifestFile || !planFile) {
    throw new Error('Invalid DGP package: assembly.glb, manifest.json, plan.json, and dgp.json are required.')
  }
  const parsedDescriptor = JSON.parse(descriptor) as { format?: string }
  if (parsedDescriptor.format !== 'disassembly-graph-package') {
    throw new Error('Unsupported DGP package format.')
  }
  const glbFile = new File([model], 'assembly.glb', { type: 'model/gltf-binary' })
  return {
    glbUrl: URL.createObjectURL(model),
    glbFile,
    manifest: JSON.parse(manifestFile) as Manifest,
    analysis: JSON.parse(planFile) as TargetAnalysis,
    filename: file.name,
  }
}
