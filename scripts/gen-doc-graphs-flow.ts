/**
 * Event-matrix and curated lifecycle/tool-pipeline pages for doc graphs.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EventEntry } from '@deepseek-ai/dsh-typert-generator'
import {
  escapeMermaidLabel as escLabel,
  graphNodeId as nodeId,
  type PackageGraphNode,
} from './package-graph.ts'
import { collectPackageSources, EventRelationCollector } from './gen-doc-graphs-events.ts'
import {
  generatedHeader, linkFromDoc, maintenanceFooter, mermaidCode, pkgLink, sourceLink,
} from './gen-doc-graphs-markdown.ts'
import { TypeScriptProject } from './ts-project.ts'

type Pkg = PackageGraphNode
const root = resolve(import.meta.dirname, '..')

interface ExamplePlugin {
  id: string
  name: string
}

interface AppExample {
  id: string
  rel: string
  title: string
  label: string
  config: string
  summary: string
}

export const APP_EXAMPLES: AppExample[] = [
  {
    id: 'dsh_base',
    rel: 'apps/cli/composition.md',
    title: 'DSH Base Composition',
    label: 'packages/bundle/base/cordis.patch.yml',
    config: 'packages/bundle/base/cordis.patch.yml',
    summary: 'The dsh-base bundle patch shared by the web, headless, sdk, and acp profiles; their mode bundles and user layers patch over it, while sdk-minimal owns a separate standalone tree.',
  },
]

function stripYamlScalar(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function parseExampleCordis(rel: string): ExamplePlugin[] {
  const text = readFileSync(resolve(root, rel), 'utf8')
  const plugins: ExamplePlugin[] = []
  let current: { id: string; name?: string } | null = null
  const flush = (): void => {
    if (current?.name) plugins.push({ id: current.id, name: current.name })
  }
  for (const line of text.split('\n')) {
    const id = /^\s*-\s+id:\s+(.+?)\s*$/.exec(line)
    if (id?.[1] !== undefined) {
      flush()
      current = { id: stripYamlScalar(id[1]) }
      continue
    }
    const name = /^\s+name:\s+(.+?)\s*$/.exec(line)
    if (name?.[1] !== undefined && current !== null) current.name = stripYamlScalar(name[1])
  }
  flush()
  return plugins
}

/** Render one app composition page from its cordis.yml patch. */
export function renderAppComposition(example: AppExample): string {
  const plugins = parseExampleCordis(example.config)
  const maintenance = 'hybrid: the patch row list is parsed from its `cordis.yml`; app package expansion is curated from package source'
  const lines = generatedHeader(example.title)
  lines.push(
    example.summary,
    '',
    '```mermaid',
    'flowchart LR',
    `  cfg["${escLabel(example.label)}<br/>cordis.yml"]`,
  )
  for (const plugin of plugins) {
    const pluginNode = nodeId(`plugin_${example.id}`, plugin.id)
    lines.push(`  ${pluginNode}["${escLabel(plugin.id)}<br/>${escLabel(plugin.name)}"]`)
    lines.push(`  cfg --> ${pluginNode}`)
  }
  lines.push(
    '```',
    '',
    '| Plugin id | Package / module |',
    '| --- | --- |',
    ...plugins.map(plugin => `| \`${plugin.id}\` | \`${plugin.name}\` |`),
    '',
    `Source config: [\`${example.config}\`](${linkFromDoc(example.rel, example.config)}).`,
  )
  lines.push('', ...maintenanceFooter(maintenance))
  return lines.join('\n')
}

function relationPackages(map: Map<string, Set<string>>, pkgsByShort: Map<string, Pkg>): string {
  if (map.size === 0) return '-'
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, methods]) => `${pkgLink(pkgsByShort.get(pkg), pkg)} (${[...methods].sort().map(m => `\`${m}\``).join(', ')})`)
    .join(', ')
}

function listenerPackages(listeners: Set<string>, pkgsByShort: Map<string, Pkg>): string {
  if (listeners.size === 0) return '-'
  return [...listeners].sort().map(pkg => pkgLink(pkgsByShort.get(pkg), pkg)).join(', ')
}

/** Render the producer/consumer matrix from the host TypeScript program. */
export function renderEventRelations(pkgs: Pkg[], events: readonly EventEntry[]): string {
  const project = new TypeScriptProject(root)
  const relations = new EventRelationCollector(project, collectPackageSources(project)).collect()
  project.close()
  const pkgsByShort = new Map(pkgs.map(pkg => [pkg.short, pkg]))
  const maintenance = 'generated: Cordis event declarations and producer/listener edges are resolved from the repository TypeScript Program'
  const lines = generatedHeader('Event Producer And Consumer Matrix')
  lines.push(
    'This matrix shows which packages dispatch each harness-owned event and which packages listen to it. Events are many-to-many, so the dense relation data is presented as a table rather than one large graph. Receiver and event-name types also cover contained dispatch sites that deliberately bypass `ctx.emit`, such as subagent lifecycle containment.',
    '',
    '| Event | Mode | Declared in | Dispatchers | Listeners |',
    '| --- | --- | --- | --- | --- |',
  )
  for (const event of [...events].sort((a, b) => a.name.localeCompare(b.name))) {
    const relation = relations.get(event.name) ?? { dispatchers: new Map<string, Set<string>>(), listeners: new Set<string>() }
    lines.push(`| \`${event.name}\` | \`${event.mode}\` | ${sourceLink(event.source)} | ${relationPackages(relation.dispatchers, pkgsByShort)} | ${listenerPackages(relation.listeners, pkgsByShort)} |`)
  }
  const undispatched = [...events]
    .filter(event => !event.source.startsWith('packages/client/'))
    .filter(event => (relations.get(event.name)?.dispatchers.size ?? 0) === 0)
    .map(event => event.name)
    .sort()
  if (undispatched.length > 0) {
    throw new Error(
      `event-producer-consumer matrix: no dispatcher found for declared event${undispatched.length > 1 ? 's' : ''} `
      + `${undispatched.map(name => `"${name}"`).join(', ')} — dead vocabulary, or a dispatch form the semantic scan misses `
      + '(teach scripts/gen-doc-graphs.ts that form)',
    )
  }
  const declared = new Set(events.map(event => event.name))
  const extra = [...relations.keys()].filter(event => !declared.has(event)).sort()
  if (extra.length > 0) {
    lines.push('', '## Non-harness or undeclared event strings seen in package source', '', '| Event string | Dispatchers | Listeners |', '| --- | --- | --- |')
    for (const event of extra) {
      const relation = relations.get(event)
      if (relation === undefined) continue
      lines.push(`| \`${event}\` | ${relationPackages(relation.dispatchers, pkgsByShort)} | ${listenerPackages(relation.listeners, pkgsByShort)} |`)
    }
  }
  lines.push('', ...maintenanceFooter(maintenance))
  return lines.join('\n')
}

/** Curated agent turn/step sequence. */
export function renderLifecycle(): string {
  const maintenance = 'curated Mermaid sequence; exact event signatures live in the generated Cordis catalog'
  return [
    ...generatedHeader('Agent Turn And Step Lifecycle'),
    'This sequence is the visual companion to [architecture.md](architecture.md#turn-flow). It keeps durable replay facts on `session/event` and live control/status on `agent/*`.',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  participant User',
    '  participant Agent',
    '  participant Driver',
    '  participant Hooks as hook listeners',
    '  participant Prompt as ctx.systemPrompt',
    '  participant LLM as ctx.llm',
    '  participant Tools as ctx.tools',
    '  participant Session',
    '  participant SDK as UI or SDK listener',
    '  User->>Agent: followup(content)',
    `  Agent-->>SDK: ${mermaidCode('agent/inbox/spliced')}`,
    `  Agent-->>SDK: ${mermaidCode('agent/inbox/inserted')} { message }`,
    '  Agent->>Driver: queued work wakes driver',
    `  Driver-->>SDK: ${mermaidCode('agent/status')} running`,
    `  Driver->>Session: ${mermaidCode('turn/start')}`,
    '  Note over Agent,Driver: claim pending next-step input plus one queued prompt',
    `  Driver-->>SDK: ${mermaidCode('agent/inbox/spliced')} pure deletion`,
    `  Driver-->>SDK: ${mermaidCode('agent/inbox/claimed')} { message, turn } per message`,
    `  Driver->>Hooks: ${mermaidCode('agent/pre-step')} waterfall`,
    '  Hooks-->>Driver: authoritative reject or enter(messages)',
    '  alt proposed step rejected or pre-step failed',
    '    Driver-->>Driver: claimed batch stays removed, the open turn spends no step',
    '  else enter proposed step',
    `  Driver->>Session: ${mermaidCode('step/start')}`,
    `  Driver->>Session: ${mermaidCode('user/message')} per entered message`,
    `  Driver->>Prompt: ${mermaidCode('system-prompt/assemble')} waterfall`,
    `  Driver->>LLM: ${mermaidCode('agent/request')} waterfall, then ${mermaidCode('llm/stream')} waterfall`,
    '  LLM-->>Driver: StreamChunk*',
    `  Driver->>Session: ${mermaidCode('assistant/chunk')}*`,
    `  Session-->>SDK: ${mermaidCode('session/event')} ${mermaidCode('assistant/chunk')}*`,
    '  alt final adapter or terminal in-band request failure',
    `    Driver->>Session: ${mermaidCode('step/end')}`,
    `    Driver->>Hooks: ${mermaidCode('agent/request-error')} waterfall`,
    '    Hooks-->>Driver: return retry action or preserve the original error',
    '  else model request succeeded',
    `  Driver->>Session: ${mermaidCode('assistant/message')}`,
    '  Driver->>Tools: classify pending call by executionMode',
    '  loop barriers and bounded rolling pool, reclassify before start',
    '    opt call starts',
    `      Driver->>Session: ${mermaidCode('tool/call')}`,
    '      Driver->>Tools: ordered pre, concurrent execute',
    '      Tools-->>Session: tool-owned events when applicable',
    '    end',
    '    opt next model-order result ready',
    '      Driver->>Tools: ordered post',
    `      Driver->>Session: ${mermaidCode('tool/result')}`,
    '    end',
    '  end',
    `  Driver->>Session: ${mermaidCode('step/end')}`,
    '  opt natural stop and next-step inbox empty',
    `    Driver->>Hooks: ${mermaidCode('agent/turn-stopping')} serial terminal checkpoint`,
    '  end',
    '  opt next-step input is pending',
    '    Driver-->>Driver: claim pending next-step input',
    `    Driver-->>SDK: ${mermaidCode('agent/inbox/claimed')} { message, turn } per message`,
    `    Driver->>Hooks: ${mermaidCode('agent/pre-step')} waterfall`,
    '    Hooks-->>Driver: authoritative reject or enter(messages)',
    '  end',
    '  end',
    '  end',
    `  Driver->>Session: ${mermaidCode('turn/end')}`,
    `  Driver-->>SDK: ${mermaidCode('agent/status')} idle`,
    '```',
    '',
    'The `assistant/message` event records every successful provider call, including content-less and `max-tokens` finishes. Empty content stays out of derived history, while the durable event keeps usage and `sourceEventSeqs` listing the exact `assistant/chunk` events, including an explicit empty list.',
    '',
    '`dsh-compaction-basic` uses `agent/pre-step` for pressure before request derivation and `agent/request-error` only for canonical context overflow. Once either trigger qualifies, optional tool-result pruning runs before summary selection. Recovery works between the closed failed step and failed turn close, and opens a fresh retry turn only when pruning or summarization advances the surface replacement generation; otherwise the original request error remains authoritative.',
    '',
    'The returned `agent/pre-step` decision is authoritative; listeners wrapping `next()` preserve downstream messages and `startsRequestSeries` unless replacement is intentional. Steering and injected context pass through the same waterfall after a later claim operation takes their next-step batch.',
    '',
    'SDK users that need replayable transcript data should consume `session/event`; `agent/*` is the live coordination API for queue/status, prompt interception, request construction, steering, continuation, and errors.',
    '',
    ...maintenanceFooter(maintenance),
  ].join('\n')
}
