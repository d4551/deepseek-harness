/**
 * Remaining capability-seam role rows for {@link ./gen-doc-graphs-roles.ts}.
 */

import type { ServiceRole } from './gen-doc-graphs-roles.ts'

/** Trailing ctx-key role rows concatenated after {@link ./gen-doc-graphs-roles.ts}. */
export const SERVICE_ROLES_TAIL: ServiceRole[] = [
  {
    key: 'userQuestions', pkg: 'user-questions', title: 'Human question/answer seam', mode: 'seam',
    consumers: ['tool-ask-user'],
    note: 'UI front ends provide the active human-answer provider; tool-ask-user pauses a tool call on the provider-neutral ask() promise.',
  },
  {
    key: 'planMode', pkg: 'plan-mode', title: 'Plan collaboration state', mode: 'core',
    note: 'Folds logged plan/mode state, flushes user selections at turn boundaries, renders deployment-owned guidance, registers /plan, and keeps the plan-exit schema stable across transitions.',
  },
  {
    key: 'agentPresets', pkg: 'agent-presets', title: 'Per-session agent composition', mode: 'core',
    note: 'Discovers preset directories over trusted and user-authored roots and mounts one preset cordis.yml under an agent scope during creation, rejecting a row that never activates or that publishes into the root service realm.',
  },
  {
    key: 'commands', pkg: 'commands', title: 'Human command registry', mode: 'core',
    note: 'Plugins register direct human commands without sending invocations to the model.',
  },
  {
    key: 'sessionProjections', pkg: 'session-projection', title: 'Session projection units', mode: 'core',
    consumers: ['api-session-controller', 'tool-todo', 'session-title'],
    note: 'Domains register state-driven fold units; the eager drive keeps per-session watermark states and the Session controller serves baselines and pushes changed values.',
  },
  {
    key: 'sessionProjectionCache', pkg: 'session-projection-cache', title: 'Persisted projection cache', mode: 'core',
    consumers: ['api-session-controller', 'session-query', 'session-reference', 'subagent'],
    note: 'Durably checkpoints projection unit states per session (throttled + turn/end/detach mandatory points) and serves the cold-read ladder: cache row + persistence tail replay, so listings never load full logs.',
  },
  {
    key: 'skills', pkg: 'skill', title: 'Skill provider registry', mode: 'seam',
    implementations: ['skill-badge', 'skill-filesystem'], consumers: ['tool-skill'],
    note: 'Merges provider skill catalogs; tool-skill renders the session-prefix catalog and loads complete skill bodies.',
  },
  {
    key: 'agents', pkg: 'agent', title: 'Agent service', mode: 'core',
    consumers: ['agent-loop', 'acp', 'subagent-in-process-driver'],
    note: 'Owns live Agent handles, the create/resume factory seam, and process-local initiator propagation.',
  },
  {
    key: 'agentDefaultModel', pkg: 'agent-default-model', title: 'Default Agent model selection', mode: 'core',
    consumers: ['api-session-controller', 'headless'],
    note: 'Layers the default ModelSelection through settings so direct and Host-backed Agent entry points share one state owner.',
  },
  {
    key: 'agentLoop', pkg: 'agent-loop', title: 'Concrete loop driver', mode: 'bundle',
    consumers: ['agent-spine-demo'],
    note: 'The one concrete loop plugin; extension packages depend on dsh-agent events and services, not on this package.',
  },
  {
    key: 'goals', pkg: 'goal', title: 'Same-session goal domain', mode: 'core',
    note: 'Folds revisioned objective state from the session log and keeps live continuation activation process-local.',
  },
  {
    key: 'e2b', pkg: 'e2b', title: 'E2B sandbox lifecycle owner', mode: 'core',
    consumers: ['fs-e2b', 'subprocess-e2b'],
    note: 'Owns one shared E2B SDK handle, remote working directory, and final sandbox disposition so both fundamental E2B providers inhabit the same Linux runtime.',
  },
  {
    key: 'subprocess', pkg: 'subprocess', title: 'Subprocess seam', mode: 'seam',
    implementations: ['subprocess-local', 'subprocess-e2b'],
    consumers: ['bash-local', 'bash-sandbox', 'terminal-bash', 'lsp-stdio', 'subagent-acp', 'subagent-codex', 'subagent-claude-code'],
    note: 'The bash executors, the PTY shell backend, the LSP host, and the out-of-process ACP, Codex, and Claude Code subagent backends spawn through ctx.subprocess; the service owns process coordinates, tree/session lifetime, stdio dispositions, terminal mechanics, and kill escalation.',
  },
  {
    key: 'shell', pkg: 'shell', title: 'Bash executor seam', mode: 'seam',
    implementations: ['bash-local', 'bash-sandbox', 'pwsh-local'],
    consumers: ['tool-bash', 'tool-pwsh', 'hooks-claude-code', 'hooks-codex'],
    note: 'The model-facing shell tools and hook bridges consume this seam; sandboxed, remote, or PowerShell executors replace bash-local without touching them.',
  },
  {
    key: 'shellEnv', pkg: 'shell-env', title: 'Managed bash environment registry', mode: 'core',
    consumers: ['tool-bash', 'tool-pwsh'],
    note: 'Plugins declare effect-scoped DSH_* facts; each shell tool collects one trusted snapshot per execution and its executor rebuilds the namespace.',
  },
  {
    key: 'terminals', pkg: 'terminal', title: 'Persistent PTY session registry', mode: 'seam',
    implementations: ['terminal-bash'], consumers: ['tool-terminal'],
    note: 'The registry owns exact-Agent session identity and cleanup; backends own terminal mechanics, while tool-terminal exposes the owner-scoped model tools.',
  },
  {
    key: 'sandbox', pkg: 'sandbox', title: 'Process-sandbox seam', mode: 'seam',
    implementations: ['sandbox-local'], consumers: ['bash-sandbox', 'terminal-bash'],
    note: 'Consumers hand over the exact argv they are about to spawn; same-world backends wrap it under a per-call policy and report enforcement.',
  },
  {
    key: 'sandboxPolicy', pkg: 'sandbox-policy', title: 'Sandbox policy home', mode: 'core',
    implementations: [], consumers: ['bash-sandbox', 'fs-sandbox', 'terminal-bash'],
    note: 'The one home for the deployment default mode + workspace root; only the sandboxed executor and provider read the service (the tool layers use the pure `sandbox/mode` fold it also exports). Both enforcing families read it so bash and fs cannot confine to different roots.',
  },
  {
    key: 'approval', pkg: 'user-approval', title: 'Approval seam', mode: 'seam',
    implementations: [], consumers: ['tools', 'tool-bash', 'acp'],
    note: 'One-shot permission decisions dispatched over the `approval/request` waterfall; answerers are listeners (the ACP bridge for its own agents), absence fails closed to `unavailable`.',
  },
  {
    key: 'permissionPresets', pkg: 'permission-presets', title: 'Permission presets', mode: 'core',
    implementations: [],
    note: 'User-facing preset table (`workspace-write`/`danger-full-access`) bundling the sandbox-mode and approval-policy knobs; a switch writes one `permission/preset` event through to both knob events.',
  },
  {
    key: 'codeRuntime', pkg: 'code-runtime', title: 'Code-execution seam', mode: 'seam',
    implementations: ['code-runtime-worker-thread'], consumers: ['tools'],
    note: 'Runs one model-written program against host-provided async bindings; backends differ by substrate and language (the tool registry consumes it for PTC mode).',
  },
  {
    key: 'fs', pkg: 'fs', title: 'Filesystem provider seam', mode: 'seam',
    implementations: ['fs-local', 'fs-sandbox', 'fs-e2b'], consumers: ['tool-fs'],
    companions: ['fs-observation-policy'],
    note: 'tool-fs executes read/write/edit through ctx.fs; fs-sandbox fences mutations by the shared sandbox mode; fs-observation-policy contributes observed-state checks through the fs/* event gate.',
  },
  {
    key: 'compaction', pkg: 'compaction', title: 'Compaction seam', mode: 'seam',
    implementations: ['compaction-basic'], consumers: ['compaction-basic'],
    note: 'The basic backend consumes post-step pressure and request-error recovery events; there is no model-facing compact tool.',
  },
  {
    key: 'subagents', pkg: 'subagent', title: 'Subagent provider and continuation service', mode: 'seam',
    implementations: ['subagent-spawn-in-process', 'subagent-fork-in-process', 'subagent-acp', 'subagent-codex', 'subagent-claude-code', 'subagent-dsh-sdk'],
    consumers: ['tool-subagent', 'tool-subagent-control', 'tool-ralph'],
    note: 'Providers implement transports; the service also owns optional Activation-based continuation orchestration, tool-subagent selects one-shot or continuable delegation, tool-subagent-control delivers follow-ups, and tool-ralph requires one fresh structured-output route.',
  },
  {
    key: 'agentTeams', pkg: 'agent-team', title: 'Agent Teams coordination domain', mode: 'core',
    consumers: ['tool-agent-team', 'client-ui-agent-team'],
    note: 'Owns the implicit-root roster, durable peer mailbox, shared task DAG, continuable-child lifecycle, and generated Team Remote methods; tool-agent-team contributes model controls and client-ui-agent-team mounts the browser contribution.',
  },
  {
    key: 'inspector', pkg: 'inspector', title: 'Cross-realm runtime inspection', mode: 'core',
    note: 'Owns the Worker-hosted CDP target and the transport-independent Host and Client observation and Cordis-tree query API.',
  },
  {
    key: 'jobs', pkg: 'jobs', title: 'Background job registry', mode: 'seam',
    implementations: ['jobs-local'],
    consumers: ['tool-bash', 'tool-terminal', 'tool-subagent', 'tool-jobs'],
    note: 'Producers (background bash, PTY sends, and subagent delegations) register running work; tool-jobs is the model-facing controller that reads, lists, and kills it; jobs-local is the process-local registry.',
  },
  {
    key: 'web', pkg: 'web', title: 'Web access provider registry', mode: 'seam',
    implementations: ['web-search-exa', 'web-search-perplexity', 'web-search-deepseek', 'web-fetch-http'],
    consumers: ['tool-web'],
    note: 'Search and fetch providers register into one ctx.web seam; tool-web owns the stable model-facing names.',
  },
  {
    key: 'spillStore', pkg: 'spill', title: 'Spill storage seam', mode: 'seam',
    implementations: ['spill-local'], consumers: ['spill-policy'],
    note: 'The backend saves oversized tool text and returns a model-facing locator plus retrieval hint; spill-policy is the tools/post-execute consumer that decides when to spill.',
  },
  {
    key: 'directoryPicker', pkg: 'host-directory-picker', title: 'Workspace-directory picking seam', mode: 'seam',
    implementations: ['host-directory-picker-native', 'host-directory-picker-browse'],
    consumers: ['api-workspace-controller'],
    note: 'Discriminated interaction capability: the native backend opens one OS chooser on the host display, the browse backend serves listing/creation primitives for the in-app browser; dual-face backends fill ui-workspace directory-flow slots from their browser halves (no wire advertisement).',
  },
  {
    key: 'webServer', pkg: 'host-webserver', title: 'HTTP route registration', mode: 'core',
    consumers: ['client-connection', 'client-modules', 'client-hmr'],
    note: 'Plain node:http carrier: named-route registry, index transform taps, and the static dist fallback; web-transport plugins register their own routes.',
  },
  {
    key: 'clientModules', pkg: 'client-modules', title: 'Client plugin graph host', mode: 'core',
    consumers: ['client-hmr'],
    note: 'Composes the __DSH_BOOT__ entry graph from an incremental dsh.client scan, serves plugin bundles, and notifies rebuilt/graph-changed subscribers.',
  },
  {
    key: 'workflowEngine', pkg: 'workflow', title: 'Workflow script engine', mode: 'seam',
    implementations: ['workflow-worker-thread'], consumers: ['tool-workflow', 'tool-ralph'],
    note: 'One engine per context, as in bash, with no named-provider registry; the general workflow and fixed Ralph consumers start runs whose agent() calls fan out through ctx.subagents.',
  },
  {
    key: 'webhookRuntime', pkg: 'webhook', title: 'Webhook rule runtime', mode: 'core',
    consumers: ['webhook-github'],
    note: 'Provider adapters dispatch authenticated deliveries; trusted plugins register independent process-local rules, and the runtime turns non-null results into ordinary Workspace-backed Sessions without delivery or completion state.',
  },
  {
    key: 'lsp', pkg: 'lsp', title: 'Language-server navigation seam', mode: 'seam',
    implementations: ['lsp-stdio'], consumers: ['tool-lsp'],
    note: 'Provider registration and selection plus normalized query execution over exactly four operations; the seam offers no protocol escape hatch, so a backend translates into the normalized request and result.',
  },
  {
    key: 'dynamicCordisRunner', pkg: 'cordis-host-runner', title: 'Dynamic Cordis package host runner', mode: 'core',
    consumers: ['tool-cordis'],
    note: 'Owns the in-memory definition registry, the vm sandbox for host halves, and the request-run round trip; browser pages reach the same service over the wire through its remote namespace.',
  },
  {
    key: 'cordisInspect', pkg: 'cordis-host-runner', title: 'Dynamic Cordis inspect registry', mode: 'core',
    consumers: ['tool-cordis'],
    note: 'Registers host inspect providers, mirrors the client provider manifest, and routes client queries through the dynamic Cordis transport.',
  },
]
