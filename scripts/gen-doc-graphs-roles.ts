/**
 * Capability-seam role classifications for {@link ./gen-doc-graphs.ts}.
 */

export interface ServiceRole {
  key: string
  pkg: string
  title: string
  mode: 'core' | 'seam' | 'bundle'
  implementations?: string[]
  consumers?: string[]
  companions?: string[]
  note: string
}

const CORE_ROLES: ServiceRole[] = [
  {
    key: 'attachments', pkg: 'attachment', title: 'Durable binary attachment storage', mode: 'seam',
    implementations: ['attachment-local'],
    consumers: ['api-session-controller', 'tool-fs', 'llm-pi-ai', 'llm-deepseek'],
    note: 'The host commits accepted images before session events; provider adapters resolve authorized durable references into provider-native content.',
  },
  {
    key: 'llm', pkg: 'llm', title: 'LLM adapter registry', mode: 'seam',
    implementations: ['llm-deepseek', 'llm-pi-ai', 'llm-replay'],
    consumers: ['agent-loop', 'compaction-basic'],
    note: 'Adapters register provider implementations; the loop and compaction call the provider-neutral stream service.',
  },
  {
    key: 'deepseekLlmApiExtensions', pkg: 'deepseek-llm-api-extensions', title: 'Official DeepSeek request extensions', mode: 'seam',
    implementations: ['session-log-deepseek', 'plugin-package-inventory-deepseek'],
    consumers: ['llm-deepseek'],
    note: 'Plugins prepare independent top-level fields; the official adapter merges them and commits their delivery state after HTTP acceptance.',
  },
  {
    key: 'tokenMeter', pkg: 'token-meter', title: 'Replay token measurement', mode: 'core',
    consumers: ['compaction-basic'],
    note: 'Owns isolated per-session replay folds; pressure consumers share immutable revisioned measurements.',
  },
  {
    key: 'toolResultPruner', pkg: 'compaction-tool-result-pruner', title: 'Model-free tool-result pruning', mode: 'core',
    consumers: ['compaction-basic'],
    note: 'Rewrites oversized current tool results through replayable single-node surface replacements before summary compaction.',
  },
  {
    key: 'sessions', pkg: 'session', title: 'In-memory session store', mode: 'core',
    consumers: ['agent-loop', 'agent', 'session-persistence', 'session-query', 'session-query-sqlite', 'subagent-in-process-driver', 'invariants', 'message-feedback'],
    note: 'Owns append-only Session instances and emits the durable session event feed.',
  },
  {
    key: 'sessionController', pkg: 'api-session-controller', title: 'Host Session Remote controller', mode: 'core',
    note: 'Owns Session commands, cold reads, durable-event following, live control state, model catalogs, workspace opening, and Agent activation policy.',
  },
  {
    key: 'sessionFileReferences', pkg: 'api-session-controller', title: 'Session-addressed file-reference Remote adapter', mode: 'core',
    note: 'Delegates file-reference discovery through the Session Controller\'s established Agent lookup policy.',
  },
  {
    key: 'sessionSkillCatalog', pkg: 'api-session-controller', title: 'Session-addressed skill Remote adapter', mode: 'core',
    note: 'Lists the Session composition\'s user-invocable skills without activating a cold Agent.',
  },
  {
    key: 'credentialsController', pkg: 'api-settings-controller', title: 'Host credential-surface Remote controller', mode: 'core',
    note: 'Projects the credential-reference seam onto the generated Remote namespace: batch fan-out, view projection, and refusal mapping live here, not on the seam Definition.',
  },
  {
    key: 'settingsController', pkg: 'api-settings-controller', title: 'Host settings-surface Remote controller', mode: 'core',
    note: 'Projects the user-settings seam onto the generated Remote namespace: the read is always redacted and every refusal is classified here, not on the seam Definition.',
  },
  {
    key: 'workspaceController', pkg: 'api-workspace-controller', title: 'Host Workspace Remote controller', mode: 'core',
    note: 'Owns Workspace commands and reconnect-safe Workspace state delivery through the generated Remote namespace.',
  },
  {
    key: 'directoryPickerController', pkg: 'api-workspace-controller', title: 'Host directory-picking Remote controller', mode: 'core',
    note: 'Carries the picking seam onto the wire: capability gating, cancellation, and the seam-coded failures a browser directory flow discriminates on.',
  },
  {
    key: 'invariants', pkg: 'invariants', title: 'Package-owned invariant registry', mode: 'core',
    consumers: ['session', 'agent', 'scope', 'agent-loop'],
    note: 'Companion subpaths register owner-local checks; the service owns selection, uniqueness, child fibers, and package-attributed failures.',
  },
  {
    key: 'typert', pkg: 'typert-registry', title: 'Runtime type registry', mode: 'core',
    consumers: ['typert-loader', 'api-gateway'],
    note: 'Plugins register live zod contributions directly or through dsh-typert-loader; the API gateway consumes invocation descriptors and providers, while other runtime consumers query schemas and reflection metadata at their own edges.',
  },
  {
    key: 'typertGateway', pkg: 'api-gateway', title: 'Typert Host invocation gateway', mode: 'core',
    note: 'Associates generated Remote descriptors with live Cordis services, resolves registered identities, and exposes unary calls through the shared Connection RPC carrier.',
  },
  {
    key: 'sessionPersistence', pkg: 'session-persistence', title: 'Durable session persistence seam', mode: 'seam',
    implementations: ['session-persistence-jsonl', 'session-persistence-sqlite'],
    consumers: ['agent-loop', 'tool-bash', 'hooks-claude-code', 'hooks-codex', 'session-query', 'session-query-sqlite', 'message-feedback'],
    note: 'Backends persist the same SessionEvent vocabulary; apps choose a backend at composition time.',
  },
  {
    key: 'settings', pkg: 'settings', title: 'User-settings seam', mode: 'seam',
    implementations: ['settings-file'],
    consumers: ['api-settings-controller', 'llm-deepseek', 'llm-pi-ai'],
    note: 'Plugins register namespace schemas and resolve layered values; providers store the raw document. The LLM adapters register their entry config as the composition base under the user section; the settings controller serves redacted layered descriptors and writes the user layer.',
  },
  {
    key: 'subagentModelSelection', pkg: 'tool-subagent', title: 'Subagent model-selection preference', mode: 'core',
    consumers: ['tool-subagent'],
    note: 'Owns the default-off settings namespace that Agent-scoped delegation tools sample when composing a new top-level Session.',
  },
  {
    key: 'credentials', pkg: 'credentials', title: 'Credential seam', mode: 'seam',
    implementations: ['credentials-local'],
    consumers: ['api-settings-controller', 'llm-deepseek', 'llm-pi-ai'],
    note: 'Configuration carries references to secrets; providers own the values. Consumers resolve per operation, so a rotated credential reaches the very next request; the settings controller exposes value-free views and write-only storage.',
  },
  {
    key: 'authorization', pkg: 'authorization', title: 'Authorization flow registry', mode: 'seam',
    implementations: [], consumers: ['llm-pi-ai'],
    note: 'Flows are registered by the plugin that knows how to obtain one credential and keyed by the record they write; the seam owns the conversation and the one-attempt-per-key lifecycle, never the protocol.',
  },
  {
    key: 'sessionTelemetry', pkg: 'session-telemetry', title: 'Session telemetry seam', mode: 'seam',
    implementations: ['session-telemetry-otel'], consumers: [],
    note: 'The seam captures, redacts, and hands session records to one backend; nothing else consumes the service — its output leaves the process.',
  },
  {
    key: 'storage', pkg: 'storage', title: 'Non-session storage hub', mode: 'seam',
    implementations: ['storage-json', 'storage-sqlite'], consumers: ['storage-domain'],
    note: 'Backends register side by side under names; data forms (domain first) mount on the hub and translate typed operations into opaque KV-unit primitives.',
  },
  {
    key: 'storageDomain', pkg: 'storage-domain', title: 'Domain data facility', mode: 'core',
    consumers: ['workspace', 'message-feedback'],
    note: 'Waits for every configured backend, then publishes the domain form as one lifecycle-bound service for typed durable state.',
  },
  {
    key: 'messageFeedback', pkg: 'message-feedback', title: 'Lifecycle-bound message feedback', mode: 'core',
    note: 'Owns local per-assistant-message feedback, lifecycle and target validation, per-item compare-and-set, and the Host unary Remote contract without entering Session history or telemetry.',
  },
  {
    key: 'workspaceRegistry', pkg: 'workspace', title: 'Workspace entity registry', mode: 'core',
    consumers: ['api-workspace-controller', 'api-session-controller'],
    note: 'Owns WorkspaceId-branded records over the domain facility; stable sessionIds accounts drive Host RPC and GUI projections.',
  },
  {
    key: 'sessionQuery', pkg: 'session-query', title: 'Session reads, traces, filters, and search', mode: 'seam',
    implementations: ['session-query-sqlite'],
    consumers: ['session-reference', 'tool-session-query'],
    note: 'The interface supplies exact reads, filters, and traces; its concrete backend adds full-text reconciliation, ranking, snippets, and cursor generations, while the model consumer owns workspace authority and cursor-free rendering.',
  },
  {
    key: 'fileReferences', pkg: 'file-reference', title: 'File reference discovery', mode: 'seam',
    implementations: ['file-reference-local'], consumers: ['api-session-controller'],
    note: 'The interface returns path-only completion candidates within an Agent cwd; providers own namespace access and ranking without reading file contents.',
  },
  {
    key: 'sessionReferenceResolver', pkg: 'session-reference', title: 'Cross-session snapshot preparation', mode: 'core',
    note: 'Projects bounded current-surface conversation snapshots into durable untrusted message context; host adapters own mention syntax.',
  },
  {
    key: 'sessionTitle', pkg: 'session-title', title: 'Log-backed session titles', mode: 'seam',
    implementations: ['session-title-first-prompt-llm', 'session-title-all-prompts-llm'],
    note: 'Owns the deterministic fallback, latest-title fold, and sole optional asynchronous provider registration.',
  },
  {
    key: 'systemPrompt', pkg: 'system-prompt', title: 'System prompt assembly registry', mode: 'core',
    consumers: ['agent-loop', 'tools', 'tool-fs', 'tool-terminal', 'tool-web'],
    note: 'Collects prompt sections and model-facing tool schemas for each step.',
  },
  {
    key: 'tools', pkg: 'tools', title: 'Tool registry and guarded execution pipeline', mode: 'core',
    consumers: ['agent-loop', 'tool-ask-user', 'tool-bash', 'tool-cordis', 'tool-fs', 'tool-terminal', 'tool-skill', 'tool-subagent', 'tool-todo', 'tool-web'],
    note: 'Registers capabilities, owns PTC mode transport, and routes calls through pre-policy, monotonic guards, around dispatch, post-policy, and final-result observation.',
  },
]

/** First half of ctx-key role rows; concatenated in {@link SERVICE_ROLES}. */
export const SERVICE_ROLES_HEAD: ServiceRole[] = CORE_ROLES
