/**
 * The staged card form: what a draft shows before it is written, which wire
 * call a save reaches, and what happens to drafts the Host did not accept.
 */

import { describe, expect, it } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { CardForm } from '../src/client/card-form.ts'
import { numberField, textField } from '../src/client/card-field-spec.ts'
import { discardSettingsFlow, saveSettingsFlow, settingsFlowState } from '../src/client/settings-flow.ts'
import { acceptWrites, type Section, setOp, unsetOp } from './scope-stubs.client.ts'

function form() {
  const host = stubSettingsScope<Section>()
  const subject = new CardForm(host.scope, [numberField('timeoutMs'), textField('baseURL')])
  host.publish({
    status: 'ready',
    writable: true,
    value: { timeoutMs: 60_000, baseURL: 'https://search.test/v1' },
    base: { timeoutMs: 60_000, baseURL: 'https://search.test/v1' },
    user: {},
  })
  return { host, subject }
}

describe('CardForm', () => {
  it('shows the effective value and stays clean until something is staged', () => {
    const { subject } = form()

    expect(subject.field('timeoutMs')).toEqual({ text: '60000', overridden: false, invalid: false })
    expect(subject.shell()).toMatchObject({ available: true, writable: true, dirty: false, invalid: false })
  })

  it('marks a field the user layer carries as overridden', () => {
    const { host, subject } = form()

    host.publish({ value: { timeoutMs: 60_000 }, user: { timeoutMs: 60_000 } })

    // An override equal to the composition default is still an override.
    expect(subject.field('timeoutMs').overridden).toBe(true)
  })

  it('writes nothing until the form is saved', async () => {
    const { host, subject } = form()
    acceptWrites(host)

    subject.actions().edit('timeoutMs', '9000')

    expect(subject.field('timeoutMs')).toEqual({ text: '9000', overridden: true, invalid: false })
    expect(subject.shell().dirty).toBe(true)
    expect(host.mutate).not.toHaveBeenCalled()

    await subject.save()

    expect(host.mutate.mock.calls).toEqual([[[setOp('timeoutMs', 9_000)]]])
    expect(subject.shell()).toMatchObject({ dirty: false, failed: false, saving: false })
  })

  it('drops a draft that settles back on the value already shown', async () => {
    const { host, subject } = form()

    subject.actions().edit('timeoutMs', '9000')
    subject.actions().edit('timeoutMs', '60000')

    expect(subject.shell().dirty).toBe(false)
    await subject.save()

    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('refuses to save while a draft is not a value the field accepts', async () => {
    const { host, subject } = form()

    subject.actions().edit('timeoutMs', 'soon')

    expect(subject.field('timeoutMs')).toEqual({ text: 'soon', overridden: false, invalid: true })
    expect(subject.shell()).toMatchObject({ dirty: true, invalid: true })

    await subject.save()

    expect(host.mutate).not.toHaveBeenCalled()
    expect(subject.field('timeoutMs').text).toBe('soon')
  })

  it('stages a reset that clears the field only once saved', async () => {
    const { host, subject } = form()
    acceptWrites(host)
    host.publish({ value: { timeoutMs: 9_000 }, user: { timeoutMs: 9_000 } })

    subject.actions().resetField('timeoutMs')

    // The badge previews the save: the field will no longer be overridden.
    expect(subject.field('timeoutMs')).toEqual({ text: '60000', overridden: false, invalid: false })
    expect(host.mutate).not.toHaveBeenCalled()

    await subject.save()

    expect(host.mutate.mock.calls).toEqual([[[unsetOp('timeoutMs')]]])
    expect(subject.shell()).toMatchObject({ dirty: false, failed: false })
  })

  it('treats resetting an inherited field as no change at all', async () => {
    const { host, subject } = form()

    subject.actions().resetField('timeoutMs')

    expect(subject.shell().dirty).toBe(false)
    await subject.save()

    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('clears a number field by emptying it', async () => {
    const { host, subject } = form()
    acceptWrites(host)
    host.publish({ user: { timeoutMs: 9_000 } })

    subject.actions().edit('timeoutMs', '')

    expect(subject.field('timeoutMs')).toEqual({ text: '', overridden: false, invalid: false })
    await subject.save()

    expect(host.mutate.mock.calls).toEqual([[[unsetOp('timeoutMs')]]])
  })

  it('clears a text field by emptying it', async () => {
    const { host, subject } = form()
    acceptWrites(host)
    host.publish({ user: { baseURL: 'https://search.test/v1' } })

    subject.actions().edit('baseURL', '   ')
    await subject.save()

    expect(host.mutate.mock.calls).toEqual([[[unsetOp('baseURL')]]])
  })

  it('writes the trimmed text of a text field', async () => {
    const { host, subject } = form()
    acceptWrites(host)

    subject.actions().edit('baseURL', '  https://other.test  ')
    await subject.save()

    expect(host.mutate.mock.calls).toEqual([[[setOp('baseURL', 'https://other.test')]]])
  })

  it('keeps the drafts a save did not land, and reports the failure', async () => {
    const { host, subject } = form()

    subject.actions().edit('timeoutMs', '9000')
    await subject.save()

    // The stub Host accepted the call without storing it, exactly as a
    // validator that refuses the value does.
    expect(host.mutate).toHaveBeenCalledWith([setOp('timeoutMs', 9_000)])
    expect(subject.shell()).toMatchObject({ dirty: true, failed: true, saving: false })
    expect(subject.field('timeoutMs').text).toBe('9000')
  })

  it('reports a reset the Host did not apply as a failure', async () => {
    const { host, subject } = form()
    host.publish({ user: { timeoutMs: 9_000 } })

    subject.actions().resetField('timeoutMs')
    await subject.save()

    expect(host.mutate).toHaveBeenCalledWith([unsetOp('timeoutMs')])
    expect(subject.shell().failed).toBe(true)
  })

  it('clears the failure as soon as the user edits again', async () => {
    const { subject } = form()

    subject.actions().edit('timeoutMs', '9000')
    await subject.save()
    expect(subject.shell().failed).toBe(true)

    subject.actions().edit('timeoutMs', '9001')

    expect(subject.shell().failed).toBe(false)
  })

  it('discards every staged edit', async () => {
    const { host, subject } = form()

    subject.actions().edit('timeoutMs', '9000')
    subject.actions().discard()

    expect(subject.field('timeoutMs').text).toBe('60000')
    expect(subject.shell()).toMatchObject({ dirty: false, failed: false })

    // A discard with nothing staged publishes nothing.
    const before = subject.shell()
    subject.actions().discard()
    expect(subject.shell()).toEqual(before)

    await subject.save()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('refuses a second save while one is in flight', async () => {
    const { host, subject } = form()
    acceptWrites(host)

    subject.actions().edit('timeoutMs', '9000')
    const first = subject.save()
    expect(subject.shell().saving).toBe(true)
    const second = subject.save()
    await Promise.all([first, second])

    expect(host.mutate).toHaveBeenCalledTimes(1)
  })

  it('retains edits made while an earlier credential save is settling', async () => {
    const host = stubSettingsScope<Section>()
    const receipt = Promise.withResolvers<boolean>()
    const written: string[] = []
    const subject = new CardForm(host.scope, [textField('baseURL')], [{
      field: 'apiKey',
      write: (text) => {
        written.push(text)
        return receipt.promise
      },
    }])
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    subject.actions().edit('apiKey', 'first-key')
    const saving = subject.save()
    expect(written).toEqual(['first-key'])
    subject.actions().edit('apiKey', 'second-key')
    subject.actions().edit('baseURL', 'https://search.test/new')
    receipt.resolve(true)
    await saving
    expect(subject.field('apiKey').text).toBe('second-key')
    expect(subject.field('baseURL').text).toBe('https://search.test/new')
    expect(subject.shell()).toMatchObject({ dirty: true, saving: false, failed: false })
  })

  it('returns the pending save to every caller and permits retry after rejection', async () => {
    const { host, subject } = form()
    const receipt = Promise.withResolvers<Awaited<ReturnType<typeof host.scope.mutate>>>()
    host.mutate.mockReturnValueOnce(receipt.promise)
    subject.actions().edit('timeoutMs', '9000')
    const saving = subject.actions().save()
    expect(subject.actions().save()).toBe(saving)
    expect(subject.saveChain).toBe(saving)
    expect(subject.shell().saving).toBe(true)

    receipt.reject(new Error('connection closed'))
    await expect(saving).resolves.toBe('failed')

    expect(subject.shell()).toMatchObject({ dirty: true, saving: false, failed: true })
    expect(subject.field('timeoutMs').text).toBe('9000')
    acceptWrites(host)
    await expect(subject.actions().save()).resolves.toBe('saved')
    expect(subject.shell()).toMatchObject({ dirty: false, saving: false, failed: false })
    expect(host.mutate).toHaveBeenCalledTimes(2)
  })

  it('retains a rejected credential draft and clears the pending state', async () => {
    const host = stubSettingsScope<Section>()
    const subject = new CardForm(host.scope, [], [{
      field: 'apiKey',
      write: () => Promise.reject(new Error('credential write refused')),
    }])
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    subject.actions().edit('apiKey', 'new-key')

    await subject.actions().save()

    expect(subject.field('apiKey').text).toBe('new-key')
    expect(subject.shell()).toMatchObject({ dirty: true, saving: false, failed: true })
  })

  it('denies a staged write when the document becomes read-only', async () => {
    const { host, subject } = form()
    subject.actions().edit('timeoutMs', '9000')
    host.publish({ writable: false })

    await subject.actions().save()

    expect(host.mutate).not.toHaveBeenCalled()
    expect(subject.shell()).toMatchObject({ writable: false, dirty: true, saving: false })
    expect(subject.field('timeoutMs').text).toBe('9000')
  })

  it('publishes a projection whenever the scope or a draft changes', () => {
    const { host, subject } = form()
    const store = subject.bind(() => subject.field('timeoutMs').text)
    expect(store.getSnapshot()).toBe('60000')

    host.publish({ value: { timeoutMs: 1_000 } })
    expect(store.getSnapshot()).toBe('1000')

    subject.actions().edit('timeoutMs', '2000')
    expect(store.getSnapshot()).toBe('2000')
  })

  it('refuses to address a field the card never declared', () => {
    const { subject } = form()

    expect(() => subject.field('nope')).toThrow('plugin card has no field nope')
  })

  it('renders an absent section value as an empty draft', () => {
    const host = stubSettingsScope<Section>()
    const subject = new CardForm(host.scope, [numberField('timeoutMs'), textField('baseURL')])

    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: undefined })

    expect(subject.field('timeoutMs').text).toBe('')
    expect(subject.field('baseURL').text).toBe('')
    expect(subject.shell().available).toBe(true)
  })

  it('stays unavailable while the namespace is not served', () => {
    const host = stubSettingsScope<Section>()
    const subject = new CardForm(host.scope, [numberField('timeoutMs')])

    host.publish({ status: 'unavailable' })

    expect(subject.shell()).toMatchObject({ available: false, writable: false })
  })
})

describe('Settings flow', () => {
  function flow() {
    const first = form()
    const second = form()
    const editors = [first, second].map(({ subject }) => ({
      state: subject.bind(() => subject.shell()),
      ...subject.actions(),
    }))
    return { first, second, editors }
  }

  it('saves both namespaces through one action and clears the combined draft', async () => {
    const { first, second, editors } = flow()
    acceptWrites(first.host)
    acceptWrites(second.host)
    first.subject.actions().edit('timeoutMs', '9000')
    second.subject.actions().edit('baseURL', 'https://review.test')

    expect(settingsFlowState(editors).dirty).toBe(true)
    await saveSettingsFlow(editors)

    expect(first.host.mutate).toHaveBeenCalledWith([setOp('timeoutMs', 9000)])
    expect(second.host.mutate).toHaveBeenCalledWith([setOp('baseURL', 'https://review.test')])
    expect(settingsFlowState(editors)).toMatchObject({ dirty: false, failed: false, saving: false })
  })

  it('validates the whole flow before writing its first namespace', async () => {
    const { first, second, editors } = flow()
    first.subject.actions().edit('timeoutMs', '9000')
    second.subject.actions().edit('timeoutMs', 'invalid')

    await saveSettingsFlow(editors)

    expect(first.host.mutate).not.toHaveBeenCalled()
    expect(second.host.mutate).not.toHaveBeenCalled()
    expect(settingsFlowState(editors)).toMatchObject({ dirty: true, invalid: true })
  })

  it('stops after a refused namespace and preserves the complete remaining draft', async () => {
    const { first, second, editors } = flow()
    first.subject.actions().edit('timeoutMs', '9000')
    second.subject.actions().edit('baseURL', 'https://review.test')

    await saveSettingsFlow(editors)

    expect(first.subject.field('timeoutMs').text).toBe('9000')
    expect(second.subject.field('baseURL').text).toBe('https://review.test')
    expect(second.host.mutate).not.toHaveBeenCalled()
    expect(settingsFlowState(editors)).toMatchObject({ dirty: true, failed: true, saving: false })
    discardSettingsFlow(editors)
    expect(settingsFlowState(editors)).toMatchObject({ dirty: false, failed: false })
  })

  it('keeps both drafts while a flow save is pending and denies a duplicate write', async () => {
    const { first, second, editors } = flow()
    const receipt = Promise.withResolvers<Awaited<ReturnType<typeof first.host.scope.mutate>>>()
    first.host.mutate.mockReturnValueOnce(receipt.promise)
    first.subject.actions().edit('timeoutMs', '9000')
    second.subject.actions().edit('baseURL', 'https://review.test')
    const saving = saveSettingsFlow(editors)

    discardSettingsFlow(editors)
    await saveSettingsFlow(editors)

    expect(first.subject.field('timeoutMs').text).toBe('9000')
    expect(second.subject.field('baseURL').text).toBe('https://review.test')
    expect(first.host.mutate).toHaveBeenCalledTimes(1)
    expect(second.host.mutate).not.toHaveBeenCalled()
    receipt.reject(new Error('connection closed'))
    await saving
    expect(settingsFlowState(editors)).toMatchObject({ dirty: true, failed: true, saving: false })
  })
})
