import { expect, it } from 'vitest'
import { settingsGroups } from '../src/client/settings-groups.ts'
import { WEB_ACCESS_NS } from '../src/client/web-access-card-controller.ts'
import { WEB_PROVIDERS } from '../src/client/web-provider-catalog.ts'
import { APPROVAL_ASSESSOR_NS } from '../src/client/approval-assessor-card-controller.ts'
import { APPROVAL_ADVERSARY_NS } from '../src/client/approval-adversary-card-controller.ts'

it('keeps routing before provider setup and screening before model decisions', () => {
  const providers = WEB_PROVIDERS.map(provider => provider.ns)
  const namespaces = [...providers, APPROVAL_ADVERSARY_NS, 'extension', WEB_ACCESS_NS, APPROVAL_ASSESSOR_NS]
  const groups = settingsGroups(namespaces)
  expect(groups.map(group => group.namespaces)).toEqual([
    [WEB_ACCESS_NS, ...providers],
    [APPROVAL_ASSESSOR_NS, APPROVAL_ADVERSARY_NS],
    ['extension'],
  ])
  expect(groups.flatMap(group => group.namespaces).sort()).toEqual(namespaces.sort())
})

it('renders only served settings and omits empty groups', () => {
  expect(settingsGroups([])).toEqual([])
  expect(settingsGroups([APPROVAL_ADVERSARY_NS])).toEqual([{
    title: 'approvalGroupTitle', namespaces: [APPROVAL_ADVERSARY_NS],
  }])
})
