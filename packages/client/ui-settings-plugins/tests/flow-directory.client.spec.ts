import { expect, it } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsFlowDirectory } from '../src/client/flow-directory.ts'
import { CardForm } from '../src/client/card-form.ts'
import { textField } from '../src/client/card-field-spec.ts'
import { acceptWrites, type Section } from './scope-stubs.client.ts'

function editor() {
  const host = stubSettingsScope<Section>()
  host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
  acceptWrites(host)
  const form = new CardForm(host.scope, [textField('endpoint')])
  return { form, state: form.bind(() => form.shell()), ...form.actions() }
}

function mirror(membership: readonly { ns: string; flow: string }[]) {
  return createSnapshotStore<SettingsMirrorSnapshot>({
    status: 'ready', error: null,
    view: {
      writable: true, hasDocument: true,
      namespaces: membership.map(member => ({
        ...member, schema: {}, value: {}, applies: 'live', secrets: [], revision: 0,
      })),
    },
  })
}

it('uses host membership for arbitrary plugins and keeps editor registration order', async () => {
  const source = mirror([{ ns: 'alpha', flow: 'research' }, { ns: 'beta', flow: 'research' }])
  const directory = new SettingsFlowDirectory(source, () => ['alpha', 'beta'])
  directory.registerFlow('research', { titleKey: 'webGroupTitle', descriptionKey: 'webFlowDescription' })
  const first = editor()
  const second = editor()
  directory.registerEditor('beta', { ...second, titleKey: 'webSearchExaTitle', descriptionKey: 'webSearchExaDescription' })
  directory.registerEditor('alpha', { ...first, titleKey: 'webAccessTitle', descriptionKey: 'webAccessDescription' })

  expect(directory.store.getSnapshot().map(flow => [flow.id, flow.members.map(member => member.ns)]))
    .toEqual([['research', ['beta', 'alpha']]])
  first.edit('endpoint', 'https://first.test')
  second.edit('endpoint', 'https://second.test')
  expect(directory.store.getSnapshot()[0]?.state.dirty).toBe(true)
  await directory.save('research')
  expect(directory.store.getSnapshot()[0]?.state).toMatchObject({ dirty: false, failed: false, saving: false })
  directory.dispose()
})

it('requires both a served namespace and a mounted editor slot', () => {
  const source = mirror([{ ns: 'alpha', flow: 'research' }])
  let slots: string[] = []
  const directory = new SettingsFlowDirectory(source, () => slots)
  directory.registerFlow('research', { titleKey: 'webGroupTitle', descriptionKey: 'webFlowDescription' })
  directory.registerEditor('alpha', { ...editor(), titleKey: 'webAccessTitle', descriptionKey: 'webAccessDescription' })
  directory.registerEditor('unserved', { ...editor(), titleKey: 'webSearchTitle', descriptionKey: 'webSearchDescription' })
  expect(directory.store.getSnapshot()).toEqual([])

  slots = ['alpha', 'unserved']
  directory.refresh()
  expect(directory.store.getSnapshot().flatMap(flow => flow.members.map(member => member.ns))).toEqual(['alpha'])
  slots = []
  directory.refresh()
  expect(directory.store.getSnapshot()).toEqual([])
  expect(() => directory.discard('research')).toThrow('unavailable')
  directory.dispose()
})

it('updates flow identity from the host and drops disposed editor registrations', () => {
  const source = mirror([{ ns: 'alpha', flow: 'research' }])
  const directory = new SettingsFlowDirectory(source, () => ['alpha'])
  directory.registerFlow('research', { titleKey: 'webGroupTitle', descriptionKey: 'webFlowDescription' })
  directory.registerFlow('review', { titleKey: 'approvalGroupTitle', descriptionKey: 'reviewFlowDescription' })
  const remove = directory.registerEditor('alpha', {
    ...editor(), titleKey: 'webAccessTitle', descriptionKey: 'webAccessDescription',
  })
  const previous = directory.store.getSnapshot()
  directory.refresh()
  expect(directory.store.getSnapshot()).toBe(previous)

  source.set(mirror([{ ns: 'alpha', flow: 'review' }]).getSnapshot())
  expect(directory.store.getSnapshot().map(flow => flow.id)).toEqual(['review'])
  remove()
  expect(directory.store.getSnapshot()).toEqual([])
  directory.dispose()
  directory.refresh()
  expect(directory.store.getSnapshot()).toEqual([])
})
