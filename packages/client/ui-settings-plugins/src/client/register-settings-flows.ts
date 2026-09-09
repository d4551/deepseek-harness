import type { SettingsFlowDirectory } from './flow-directory.ts'
import type { ApprovalAssessorCardController } from './approval-assessor-card-controller.ts'
import type { ApprovalAdversaryCardController } from './approval-adversary-card-controller.ts'
import type { WebAccessCardController } from './web-access-card-controller.ts'
import type { WebSearchCardController } from './web-search-card-controller.ts'
import type { WebProviderCardController } from './web-provider-card-controller.ts'
import { APPROVAL_ASSESSOR_NS } from './approval-assessor-card-controller.ts'
import { APPROVAL_ADVERSARY_NS } from './approval-adversary-card-controller.ts'
import { WEB_ACCESS_NS } from './web-access-card-controller.ts'
import { WEB_SEARCH_NS } from './web-search-card-controller.ts'

interface FlowControllers {
  webAccess: WebAccessCardController
  webSearch: WebSearchCardController
  webProviders: readonly WebProviderCardController[]
  approvalAssessor: ApprovalAssessorCardController
  approvalAdversary: ApprovalAdversaryCardController
}

/** Register flow presentation and editors; the host supplies their membership. */
export function registerSettingsFlows(directory: SettingsFlowDirectory, controllers: FlowControllers): () => number {
  const access = controllers.webAccess.inject()
  const search = controllers.webSearch.inject()
  const assessor = controllers.approvalAssessor.inject()
  const adversary = controllers.approvalAdversary.inject()
  const remove = [
    directory.registerFlow(WEB_ACCESS_NS, {
      titleKey: 'webGroupTitle', descriptionKey: 'webFlowDescription',
    }),
    directory.registerFlow('agent-review', {
      titleKey: 'approvalGroupTitle', descriptionKey: 'reviewFlowDescription',
    }),
    directory.registerEditor(WEB_ACCESS_NS, {
      state: access.hooks.webAccessCard, save: access.save, discard: access.discard,
      titleKey: 'webAccessTitle', descriptionKey: 'webAccessDescription',
    }),
    directory.registerEditor(WEB_SEARCH_NS, {
      state: search.hooks.webSearchCard, save: search.save, discard: search.discard,
      titleKey: 'webSearchTitle', descriptionKey: 'webSearchDescription',
    }),
    directory.registerEditor(APPROVAL_ASSESSOR_NS, {
      state: assessor.hooks.approvalAssessorCard, save: assessor.save, discard: assessor.discard,
      titleKey: 'approvalAssessorTitle', descriptionKey: 'approvalAssessorDescription',
    }),
    directory.registerEditor(APPROVAL_ADVERSARY_NS, {
      state: adversary.hooks.approvalAdversaryCard, save: adversary.save, discard: adversary.discard,
      titleKey: 'approvalAdversaryTitle', descriptionKey: 'approvalAdversaryDescription',
    }),
    ...controllers.webProviders.map((controller) => {
      const face = controller.inject()
      return directory.registerEditor(controller.namespace, {
        state: face.hooks.webProviderCard, save: face.save, discard: face.discard,
        titleKey: face.spec.titleKey, descriptionKey: face.spec.descriptionKey,
      })
    }),
  ]
  return () => {
    let removed = 0
    for (const dispose of remove.toReversed()) {
      if (dispose()) removed += 1
    }
    return removed
  }
}
