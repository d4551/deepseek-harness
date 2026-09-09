import { APPROVAL_ASSESSOR_NS } from './approval-assessor-card-controller.ts'
import { APPROVAL_ADVERSARY_NS } from './approval-adversary-card-controller.ts'
import { WEB_ACCESS_NS } from './web-access-card-controller.ts'
import { WEB_PROVIDERS } from './web-provider-catalog.ts'
import type { PluginsSettingsLocaleKey } from './locales.ts'

interface SettingsGroup {
  title: PluginsSettingsLocaleKey
  namespaces: string[]
}

/** Group served settings by the capability their registered editors configure. */
export function settingsGroups(namespaces: readonly string[]): SettingsGroup[] {
  const web = [WEB_ACCESS_NS, ...WEB_PROVIDERS.map(provider => provider.ns)]
  const approval = [APPROVAL_ASSESSOR_NS, APPROVAL_ADVERSARY_NS]
  const groups: SettingsGroup[] = [
    { title: 'webGroupTitle', namespaces: web.filter(ns => namespaces.includes(ns)) },
    { title: 'approvalGroupTitle', namespaces: approval.filter(ns => namespaces.includes(ns)) },
    {
      title: 'otherGroupTitle',
      namespaces: namespaces.filter(ns => !web.includes(ns) && !approval.includes(ns)),
    },
  ]
  return groups.filter(group => group.namespaces.length > 0)
}
