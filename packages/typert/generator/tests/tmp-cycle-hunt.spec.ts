/**
 * Temporary diagnostic: walk the host type graph along the exact edges the
 * Zod schema emitter recurses through and report the first cycle or runaway
 * path. Deleted once the offending declaration is identified and fixed.
 */
import { describe, it } from 'vitest'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import type { MemberModel, TypeNodeModel } from '../src/model.ts'

type Id = string

/** Edges the emitter actually recurses through when rendering one node. */
function emissionChildren(node: TypeNodeModel): Id[] {
  switch (node.kind) {
    case 'parenthesized': return [node.type]
    case 'reference': return [...node.arguments]
    case 'union':
    case 'intersection': return [...node.types]
    case 'array': return [node.element]
    case 'tuple': return node.elements.map(element => element.type)
    case 'object': return memberEdges(node.members)
    default: return []
  }
}

function memberEdges(members: readonly MemberModel[]): Id[] {
  const ids: Id[] = []
  for (const member of members) {
    if (member.kind === 'property') {
      ids.push(member.type)
    } else if (member.kind === 'index') {
      for (const parameter of member.signature.parameters) ids.push(parameter.type)
      ids.push(member.signature.returns)
    }
  }
  return ids
}

describe('temporary schema cycle hunt', () => {
  it('names the first cycle on the emitter recursion path', () => {
    const analyzer = new WorkspaceAnalyzer({
      root: process.cwd(),
      faces: ['host'],
      checkDiagnostics: false,
      packages: [
        '@deepseek-ai/dsh-api-session-controller',
        '@deepseek-ai/dsh-api-settings-controller',
        '@deepseek-ai/dsh-api-workspace-controller',
        '@deepseek-ai/dsh-session-reference',
        '@deepseek-ai/dsh-experimental-agent-team',
        '@deepseek-ai/dsh-cordis-host-runner',
        '@deepseek-ai/dsh-message-feedback',
        '@deepseek-ai/dsh-goal',
        '@deepseek-ai/dsh-plugin-inventory',
        '@deepseek-ai/dsh-commands',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-agent-presets',
        '@deepseek-ai/dsh-subagent',
      ],
    })
    const model = analyzer.analyze()
    const host = model.faces.find(face => face.face === 'host')
    if (host === undefined) throw new Error('host face produced no model')

    const nodes = new Map<Id, TypeNodeModel>(host.graph.nodes.map(node => [node.id, node]))
    const describeNode = (id: Id): string => {
      const node = nodes.get(id)
      if (node === undefined) return `${id} (missing)`
      return node.kind === 'reference' ? `${id} [reference ${node.name}]` : `${id} [${node.kind}]`
    }

    const done = new Set<Id>()
    const path: Id[] = []
    let visits = 0
    const walk = (id: Id): string | undefined => {
      visits += 1
      if (visits > 2_000_000) {
        return `runaway graph: over 2,000,000 node visits; path tail ${path.slice(-10).map(describeNode).join(' -> ')}`
      }
      if (path.includes(id)) {
        const start = path.indexOf(id)
        const cycle = [...path.slice(start), id]
        return `cycle of ${String(cycle.length - 1)} nodes: ${cycle.map(describeNode).join(' -> ')}`
      }
      if (done.has(id)) return undefined
      path.push(id)
      const node = nodes.get(id)
      if (node !== undefined) {
        for (const child of emissionChildren(node)) {
          const found = walk(child)
          if (found !== undefined) return found
        }
      }
      path.pop()
      done.add(id)
      return undefined
    }

    const failures: string[] = []
    for (const pkg of host.packages) {
      const roots: Id[] = []
      for (const schema of pkg.schemas) roots.push(schema.type)
      for (const invocation of pkg.invocations) {
        roots.push(invocation.result.codecType)
        if (invocation.invocation.kind === 'context') roots.push(invocation.invocation.boundary.codecType)
        for (const parameter of invocation.parameters) roots.push(parameter.boundary.codecType)
      }
      for (const root of roots) {
        path.length = 0
        const found = walk(root)
        if (found !== undefined) failures.push(`${pkg.name}: ${found}`)
      }
    }
    if (failures.length > 0) throw new Error(`schema emission recursion defects:\n${failures.slice(0, 5).join('\n')}`)
  })
})
