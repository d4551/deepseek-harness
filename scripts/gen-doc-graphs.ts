/**
 * Generate the relationship layer above the module, Cordis, and tool catalogs.
 * Enumerable facts come from source; hybrid graphs add manifests for policy the
 * source cannot infer, while curated graphs explain flow and ownership.
 * `--check` verifies the generated set.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { projectCordisCatalog } from '@deepseek-ai/dsh-typert-generator'
import { CORDIS_CATALOG_POLICY } from './gen-cordis-catalog.ts'
import { collectPackageGraph } from './package-graph.ts'
import { APP_EXAMPLES, renderAppComposition, renderEventRelations, renderLifecycle } from './gen-doc-graphs-flow.ts'
import { generatedHeader, graphIndexLink, maintenanceFooter, renderCapabilitySeams } from './gen-doc-graphs-markdown.ts'
import { renderToolPipeline } from './gen-doc-graphs-pipeline.ts'

const root = resolve(import.meta.dirname, '..')

const GROUP_ORDER = [
  'util', 'attachment', 'llm', 'core', 'typert', 'goal', 'experimental', 'process',
  'bash', 'pty', 'sandbox', 'e2b', 'fs', 'skill', 'compact', 'subagent', 'tasks',
  'workflow', 'web', 'webhook', 'spill', 'todo', 'plan', 'cordis', 'hooks',
  'session-persistence', 'session-query', 'session-title', 'telemetry', 'storage',
  'workspace', 'support', 'acp', 'ui',
]

interface GraphDoc {
  rel: string
  content: string
}

function renderIndex(docs: GraphDoc[]): string {
  const labels: Record<string, string> = {
    'docs/capability-seams.md': 'capability seams and core services',
    'apps/cli/composition.md': 'dsh shared base composition',
    'docs/event-producer-consumer.md': 'event producer/consumer matrix',
    'docs/agent-lifecycle.md': 'agent turn and step lifecycle',
    'docs/tool-execution-pipeline.md': 'tool execution pipeline',
  }
  const modes: Record<string, string> = {
    'docs/capability-seams.md': 'hybrid generated',
    'apps/cli/composition.md': 'hybrid generated',
    'docs/event-producer-consumer.md': 'hybrid generated',
    'docs/agent-lifecycle.md': 'curated',
    'docs/tool-execution-pipeline.md': 'curated',
  }
  const rows = [
    '| [module dependency graph](module-graph.md) | `generated` |',
    '| [tool schema catalog and package map](tool-catalog.md) | `generated` |',
    ...docs.map((doc) => {
      const link = graphIndexLink(doc.rel)
      return `| [${labels[doc.rel] ?? link}](${link}) | \`${modes[doc.rel] ?? 'generated'}\` |`
    }),
  ]
  const maintenance = 'mixed: each linked page declares generated, hybrid, or curated mode'
  return [
    ...generatedHeader('Documentation Graph Index'),
    'These diagrams show relationships that the generated catalogs do not. Use them to find package relationships, capability seams, event flow, model-facing tools, app composition, and runtime lifecycle paths. Exact signatures and type definitions still live in the [subsystem pages](subsystems/core.md) (types + the generated Cordis API regions) and [tool-catalog.md](tool-catalog.md).',
    '',
    'The process decision behind this index is recorded in [the documentation graph Agent Note](../.agents/notes/archived/process/2026-07-03-documentation-graph-atlas.md).',
    '',
    '| Graph | Mode |',
    '| --- | --- |',
    ...rows,
    '',
    'Regenerate with `bun run gen-doc-graphs`; verify freshness with `bun run verify-doc-graphs`.',
    '',
    ...maintenanceFooter(maintenance),
  ].join('\n')
}

function renderDocs(): GraphDoc[] {
  const pkgs = collectPackageGraph(root, GROUP_ORDER, 'gen-doc-graphs')
  const { model } = projectCordisCatalog(root, CORDIS_CATALOG_POLICY)
  const docs: GraphDoc[] = [
    { rel: 'docs/capability-seams.md', content: renderCapabilitySeams(pkgs, model.services) },
    ...APP_EXAMPLES.map(example => ({ rel: example.rel, content: renderAppComposition(example) })),
    { rel: 'docs/event-producer-consumer.md', content: renderEventRelations(pkgs, model.events) },
    { rel: 'docs/agent-lifecycle.md', content: renderLifecycle() },
    { rel: 'docs/tool-execution-pipeline.md', content: renderToolPipeline() },
  ]
  docs.unshift({ rel: 'docs/graph-atlas.md', content: renderIndex(docs) })
  return docs
}

function main(): void {
  const docs = renderDocs()
  if (process.argv.includes('--check')) {
    const stale: string[] = []
    for (const doc of docs) {
      const abs = resolve(root, doc.rel)
      const committed = existsSync(abs) ? readFileSync(abs, 'utf8') : null
      if (committed !== doc.content) stale.push(doc.rel)
    }
    if (stale.length === 0) {
      process.stdout.write(`gen-doc-graphs: ${String(docs.length)} graph doc(s) are up to date.\n`)
      return
    }
    process.stderr.write(`gen-doc-graphs: stale graph doc(s): ${stale.join(', ')}. Run \`bun run gen-doc-graphs\` and commit the result.\n`)
    process.exit(1)
  }

  for (const doc of docs) {
    mkdirSync(dirname(resolve(root, doc.rel)), { recursive: true })
    writeFileSync(resolve(root, doc.rel), doc.content)
  }
  process.stdout.write(`gen-doc-graphs: wrote ${String(docs.length)} graph doc(s).\n`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main()
}
