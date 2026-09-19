/** Shared projection of the live LLM registry into the browser model catalog. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ModelCatalog,
  ModelReasoning,
  ModelSelection,
} from './types.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

/**
 * Build the browser model catalog without requiring a Session.
 * @param ctx - Host context carrying the live LLM registry.
 * @param defaultSelection - deployment default used before a Session selects a model.
 * @returns successful non-empty provider groups and isolated provider failures.
 */
export async function buildModelCatalog(
  ctx: Context,
  defaultSelection: ModelSelection = ctx.agentDefaultModel.currentSelection(),
): Promise<ModelCatalog> {
  const providers = ctx.llm.listProviders()
  const catalog = await Promise.all(providers.map(provider => ctx.llm.listModels(provider.id).then(
    models => Promise.all(models.map(async (model) => {
      const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)
      const reasoning: ModelReasoning | undefined = resolved.reasoning === undefined
        ? undefined
        : {
          efforts: resolved.reasoning.efforts.map(effort => ({
            id: effort.id,
            name: effort.name,
            ...(effort.description === undefined ? {} : { description: effort.description }),
          })),
          ...(resolved.reasoning.defaultEffort === undefined
            ? {}
            : { defaultEffort: resolved.reasoning.defaultEffort }),
        }
      return {
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(reasoning === undefined ? {} : { reasoning }),
      }
    })).then(entries => ({
      kind: 'group' as const,
      group: {
        id: provider.id,
        name: provider.name,
        models: entries,
        ...(provider.hosting === undefined ? {} : { hosting: provider.hosting }),
      },
    })),
  ).then(undefined, (error: Thrown) => ({
    kind: 'failure' as const,
    failure: {
      id: provider.id,
      name: provider.name,
      message: error instanceof Error ? error.message : String(error),
    },
  }))))
  return {
    default: { ...defaultSelection },
    routableProviders: providers.map(provider => provider.id),
    groups: catalog.flatMap(item => item.kind === 'group' ? [item.group] : [])
      .filter(group => group.models.length > 0),
    failures: catalog.flatMap(item => item.kind === 'failure' ? [item.failure] : []),
  }
}
