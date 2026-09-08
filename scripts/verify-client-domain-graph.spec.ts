import { describe, expect, it } from 'vitest'
import { clientDomainViolations, resolveClientImport } from './verify-client-domain-graph.ts'

describe('client domain import resolution', () => {
  it('preserves imports that leave src/client from a top-level file', () => {
    expect(resolveClientImport('styles.ts', '../styles/base.css?inline'))
      .toBe('../styles/base.css?inline')
  })

  it('normalizes imports between domains inside src/client', () => {
    expect(resolveClientImport('input/hub.ts', '../queue/store.ts'))
      .toBe('queue/store.ts')
  })

  it.each([
    'import { state } from "../queue/store.ts"',
    'import "../queue/store.ts"',
    'export * from "../queue/store.ts"',
    'export { state } from "../queue/store.ts"',
    'import("../queue/store.ts")',
    'import(`../queue/store.ts`)',
    'require("../queue/store.ts")',
    'require.resolve("../queue/store.ts")',
    'require?.("../queue/store.ts")',
    'import state = require("../queue/store.ts")',
    'type State = import("../queue/store.ts").State',
    'import "..\\x2fqueue/store.ts"',
  ])('detects sibling domain references in %s', (source) => {
    expect(clientDomainViolations('input/hub.ts', source)).toEqual([{
      file: 'input/hub.ts',
      imported: '../queue/store.ts',
      reason: 'domain "input" imports sibling domain "queue" (route shared API through contract/)',
    }])
  })

  it('checks source with obsolete filename markers', () => {
    expect(clientDomainViolations('input/hub.legacy.ts', 'import "../queue/store.ts"')).toHaveLength(1)
  })

  it('checks top-level non-assembly imports', () => {
    expect(clientDomainViolations('hub.ts', 'import "./queue/store.ts"')).toEqual([{
      file: 'hub.ts', imported: './queue/store.ts',
      reason: 'top-level non-assembly file imports domain "queue" (only apply/index may assemble)',
    }])
  })

  it('permits same-domain, contract, shared, external, and package-level references', () => {
    expect(clientDomainViolations('input/hub.ts', `
      import './state.ts'
      import '../contract/state.ts'
      import '../shared.ts'
      import '../../styles/base.css'
      import 'react'
      const message = 'from "../queue/store.ts"'
      // import '../queue/store.ts'
    `)).toEqual([])
  })

  it.each(['apply.ts', 'index.ts', 'index.tsx'])('permits composition in %s', (file) => {
    expect(clientDomainViolations(file, 'import "./queue/store.ts"')).toEqual([])
  })

  it('parses TSX and reports syntax errors even in assembly files', () => {
    expect(clientDomainViolations('input/view.tsx', 'import "../queue/store.ts"; const view = <div />')).toHaveLength(1)
    expect(() => clientDomainViolations('index.ts', 'const =')).toThrow()
  })
})
