import { afterAll, expect, it } from 'vitest'
import { slotDeclarations, standardKitMembers } from './slot-walk.ts'
import { closeCompiler, createSourceFile } from './ts7-session.ts'

afterAll(closeCompiler)

it('rejects an unannotated slot with its source location', () => {
  const file = {
    rel: 'packages/client/example/src/slots.ts',
    package: '@example/slots',
    sf: createSourceFile('slots.ts', "declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { 'example.entry' } }"),
  }
  expect(() => slotDeclarations(file)).toThrow(
    'packages/client/example/src/slots.ts:1: SlotMap member example.entry requires an explicit type annotation',
  )
})

it.each(['kind', 'scope', 'owner', 'keyProps', 'hookContext', 'inject'])('rejects an unannotated slot field %s', (field) => {
  const file = {
    rel: 'packages/client/example/src/slots.ts',
    package: '@example/slots',
    sf: createSourceFile('slots.ts', `declare module '@deepseek-ai/dsh-client-ui-slots' {
      interface SlotMap { 'example.entry': { ${field} } }
    }`),
  }
  expect(() => slotDeclarations(file)).toThrow(`SlotMap member ${field} requires an explicit type annotation`)
})

it.each(['GlobalStandardProps', 'SessionStandardProps', 'SessionMaybeStandardProps'])(
  'rejects an unannotated %s member with its source location', (name) => {
    const file = {
      rel: 'packages/client/example/src/slots.ts',
      package: '@example/slots',
      sf: createSourceFile('slots.ts', `declare module '@deepseek-ai/dsh-client-ui-slots' { interface ${name} { entry } }`),
    }
    expect(() => standardKitMembers([file], name)).toThrow(
      `packages/client/example/src/slots.ts:1: ${name} member entry requires an explicit type annotation`,
    )
  },
)

it('preserves annotated optional members and reports absent optional slot fields as absent', () => {
  const file = {
    rel: 'packages/client/example/src/slots.ts',
    package: '@example/slots',
    sf: createSourceFile('slots.ts', `declare module '@deepseek-ai/dsh-client-ui-slots' {
      interface SlotMap { 'example.entry': { kind: 'single'; scope: 'root'; owner?: { title: string } } }
      interface GlobalStandardProps { entry?: string }
    }`),
  }
  expect(slotDeclarations(file)).toEqual([{
    key: 'example.entry', kind: 'single', scope: 'root', ownerType: '{ title: string }', jsDoc: '',
    package: '@example/slots', source: 'packages/client/example/src/slots.ts:2',
  }])
  expect(standardKitMembers([file], 'GlobalStandardProps')).toEqual(['entry?: string'])
})
