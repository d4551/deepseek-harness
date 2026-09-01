/** Browser-safe vocabulary for the subagent model-selection settings section. */

/** One exact child LLM route authorized by a user setting. */
export interface AllowedModelRoute {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
}

/**
 * Stored user preference; the shipped composition defaults it off.
 *
 * The Client settings card that edits this section binds its scope to this
 * declaration, so the stored field set has one home rather than a Host copy
 * and a browser copy that can drift apart.
 */
export interface SubagentModelSelectionSettings {
  /** Whether newly composed top-level Sessions receive model selection. */
  enabled: boolean
  /** Exact child LLM routes offered to newly composed top-level Sessions. */
  allowedModels: AllowedModelRoute[]
}
