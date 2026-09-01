/** Browser-safe vocabulary for the default model selection settings section. */

/**
 * Stored and composed default model selection.
 *
 * The Client settings card that edits this section binds its scope to this
 * declaration, so the stored field set has one home rather than a Host copy
 * and a browser copy that can drift apart.
 */
export interface AgentDefaultModelSettings {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}
