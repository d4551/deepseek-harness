/* Debug: find cyclic type nodes in the host-face Typert graph. */
import { WorkspaceAnalyzer } from '../packages/typert/generator/src/analyzer-workspace.ts'
import { childTypeNodeIds } from '../packages/typert/generator/src/model.ts'
import type { TypeNodeId } from '../packages/typert/generator/src/model.ts'

const out = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

const root = process.cwd()
const analyzer = new WorkspaceAnalyzer({ root, faces: ['host'], checkDiagnostics: false })
const model = analyzer.analyze()
const host = model.faces.find(face => face.face === 'host')
if (host === undefined) throw new Error('no host face')

const nodes = new Map(host.graph.nodes.map(node => [node.id, node]))
out(`nodes=${String(nodes.size)} declarations=${String(host.graph.declarations.length)}`)

const state = new Map<TypeNodeId, 'visiting' | 'done'>()
const stack: TypeNodeId[] = []
const cycles: TypeNodeId[][] = []
const visit = (id: TypeNodeId): void => {
  const marker = state.get(id)
  if (marker === 'done') return
  if (marker === 'visiting') {
    const start = stack.indexOf(id)
    cycles.push([...stack.slice(start), id])
    return
  }
  state.set(id, 'visiting')
  stack.push(id)
  const node = nodes.get(id)
  if (node !== undefined) for (const child of childTypeNodeIds(node)) visit(child)
  stack.pop()
  state.set(id, 'done')
}
for (const id of nodes.keys()) visit(id)

out(`cycles=${String(cycles.length)}`)
for (const cycle of cycles.slice(0, 5)) {
  out('CYCLE:')
  for (const id of cycle) {
    const node = nodes.get(id)
    const summary = node === undefined ? 'missing' : node.kind === 'reference' ? `reference ${node.name}` : node.kind
    out(`  ${id} :: ${summary}`)
  }
}

const cycleIds = new Set(cycles.flat())
const reaches = (rootId: TypeNodeId): boolean => {
  const seen = new Set<TypeNodeId>()
  const queue = [rootId]
  while (queue.length > 0) {
    const current = queue.shift() as TypeNodeId
    if (cycleIds.has(current)) return true
    if (seen.has(current)) continue
    seen.add(current)
    const node = nodes.get(current)
    if (node !== undefined) queue.push(...childTypeNodeIds(node))
  }
  return false
}
for (const packageModel of host.packages) {
  for (const schema of packageModel.schemas) {
    if (reaches(schema.type)) out(`schema root reaching cycle: ${packageModel.name} ${schema.export.name}`)
  }
  for (const invocation of packageModel.invocations) {
    for (const parameter of invocation.parameters) {
      if (reaches(parameter.boundary.type)) out(`invocation param reaching cycle: ${invocation.id} ${parameter.name}`)
    }
    if (reaches(invocation.result.type)) out(`invocation result reaching cycle: ${invocation.id}`)
  }
}
