import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectPackageInvariantViolations,
  formatPackageInvariantViolation,
} from './package-invariants.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function handwrittenInvariant(packageName: string): string {
  return `
export const name = 'probe-invariant'
export const inject = ['invariants']
const install = (ctx: { on(name: string, listener: (value: number) => void): void }, fail: (message: string) => never) => {
  ctx.on('probe/value', (value) => {
    if (value < 0) fail('observed values must be non-negative')
  })
}
export const apply = (ctx: { invariants: { register(name: string, install: typeof install): () => void } }) =>
  Promise.resolve(ctx.invariants.register(${JSON.stringify(packageName)}, install))
`
}

function fixture(options: {
  packageName?: string
  source?: string
  invariantExport?: boolean
  invariantDependency?: boolean
  invariantReference?: boolean
  buildEntry?: boolean
  publishedInvariant?: boolean
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-invariants-'))
  roots.push(root)
  const dir = join(root, 'packages/core/probe')
  mkdirSync(join(dir, 'src'), { recursive: true })
  const packageName = options.packageName ?? '@deepseek-ai/dsh-probe'
  const manifest = {
    name: packageName,
    exports: options.invariantExport === false ? {} : {
      './invariant': {
        types: './lib/types/invariant.d.ts',
        default: './lib/invariant.js',
      },
    },
    files: options.publishedInvariant === false ? ['lib/index.js'] : ['lib/index.js', 'lib/invariant.js'],
    peerDependencies: options.invariantDependency === false ? {} : {
      '@deepseek-ai/dsh-invariants': 'workspace:^',
    },
    devDependencies: options.invariantDependency === false ? {} : {
      '@deepseek-ai/dsh-invariants': 'workspace:^',
    },
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify({
    references: options.invariantReference === false ? [] : [{ path: '../../runtime-diagnostics/invariants' }],
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'src/invariant.ts'), options.source ?? handwrittenInvariant(packageName))
  writeFileSync(
    join(dir, 'tsdown.config.ts'),
    options.buildEntry === false ? "export default { entry: ['lib/types/index.js'] }\n" : "export default { entry: ['lib/types/index.js', 'lib/types/invariant.js'] }\n",
  )
  return root
}

describe('package invariant gate', () => {
  it('accepts a hand-owned checking companion with publication metadata', () => {
    expect(collectPackageInvariantViolations(fixture())).toEqual([])
  })

  it('accepts an invariant reference owned by a package-local leaf project', () => {
    const root = fixture({ invariantReference: false })
    const dir = join(root, 'packages/core/probe')
    writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify({
      files: [],
      references: [{ path: './tsconfig.host.json' }],
    }, null, 2)}\n`)
    writeFileSync(join(dir, 'tsconfig.host.json'), `${JSON.stringify({
      references: [{ path: '../../runtime-diagnostics/invariants' }],
    }, null, 2)}\n`)

    expect(collectPackageInvariantViolations(root)).toEqual([])
  })

  it('rejects missing publication metadata and build output', () => {
    const violations = collectPackageInvariantViolations(fixture({
      invariantExport: false,
      invariantDependency: false,
      invariantReference: false,
      buildEntry: false,
      publishedInvariant: false,
    }))
    expect(violations.map(violation => violation.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('exports["./invariant"]'),
      expect.stringContaining('peerDependency'),
      expect.stringContaining('devDependency'),
      expect.stringContaining('TypeScript project references'),
      expect.stringContaining('must bundle lib/types/invariant.js'),
      'files must publish lib/invariant.js',
    ]))
  })

  it('rejects foreign, duplicate, and unresolved registrations', () => {
    const source = `
export const name = 'probe-invariant'
export const inject = ['invariants']
const selected = process.env.PACKAGE_NAME
const install = (_ctx: unknown, fail: (message: string) => never) => { fail('probe') }
export const apply = (ctx: { invariants: { register(name: string, install: typeof install): () => void } }) => {
  ctx.invariants.register('@deepseek-ai/dsh-foreign', install)
  return ctx.invariants.register(selected!, install)
}
`
    const violations = collectPackageInvariantViolations(fixture({ source }))
    expect(violations.map(violation => violation.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('must resolve to a local string constant'),
      expect.stringContaining('must register exactly its own package name'),
    ]))
  })

  it('rejects generated markers and reporter-free executable installers', () => {
    const generated = fixture({
      source: `/** @generated */\n${handwrittenInvariant('@deepseek-ai/dsh-probe')}`,
    })
    expect(collectPackageInvariantViolations(generated).map(violation => violation.message))
      .toContain('invariant companions must be hand-owned and may not carry @generated markers')

    const reporterFree = fixture({
      source: `
export const name = 'probe-invariant'
export const inject = ['invariants']
const install = () => { void 0 }
export const apply = (ctx: { invariants: { register(name: string, install: typeof install): () => void } }) =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-probe', install))
`,
    })
    expect(collectPackageInvariantViolations(reporterFree).map(violation => violation.message))
      .toContain('install function must accept the bound failure reporter as its second parameter')

    const unused = fixture({
      source: `
export const name = 'probe-invariant'
export const inject = ['invariants']
const install = (_ctx: unknown, _fail: (message: string) => never) => { void 0 }
export const apply = (ctx: { invariants: { register(name: string, install: typeof install): () => void } }) =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-probe', install))
`,
    })
    expect(collectPackageInvariantViolations(unused).map(violation => violation.message))
      .toContain('install function must use its bound failure reporter')
  })

  it('rejects registering a different installer than the checked local function', () => {
    const decoy = fixture({
      source: `
export const name = 'probe-invariant'
export const inject = ['invariants']
const install = (_ctx: unknown, fail: (message: string) => never) => { fail('checked decoy') }
export const apply = (ctx: { invariants: { register(name: string, install: () => void): () => void } }) =>
  ctx.invariants.register('@deepseek-ai/dsh-probe', () => {})
`,
    })
    expect(collectPackageInvariantViolations(decoy).map(violation => violation.message))
      .toContain('line 6: ctx.invariants.register must use the checked local install function')
  })

  it.each([
    'export default { name, inject, apply }',
    "export * as default from './probe.ts'",
    'export { apply as default }',
    'export default function invariantPlugin() {}',
    'export default class InvariantPlugin {}',
    'export default interface InvariantPlugin {}',
  ])('rejects a default export that would collapse the Loader namespace', (defaultExport) => {
    const source = `${handwrittenInvariant('@deepseek-ai/dsh-probe')}\n${defaultExport}\n`
    expect(collectPackageInvariantViolations(fixture({ source })).map(violation => violation.message))
      .toContain('must not default-export; Loader must retain the companion namespace')
  })

  it('rejects unnamed package ownership', () => {
    expect(() => collectPackageInvariantViolations(fixture({ packageName: '' })))
      .toThrow('packages/core/probe/package.json: package invariant owner must declare a package name')
  })

  it('requires the companion source even when publication metadata exists', () => {
    const root = fixture()
    rmSync(join(root, 'packages/core/probe/src/invariant.ts'))
    expect(collectPackageInvariantViolations(root)).toEqual([{
      path: 'packages/core/probe/src/invariant.ts',
      message: 'missing package-owned invariant companion',
    }])
  })

  it('accepts the registry package without a dependency on itself', () => {
    const root = fixture({
      packageName: '@deepseek-ai/dsh-invariants',
      invariantDependency: false,
      invariantReference: false,
    })
    rmSync(join(root, 'packages/core/probe/tsdown.config.ts'))
    expect(collectPackageInvariantViolations(root)).toEqual([])
  })

  it('rejects missing invariant references despite cyclic and missing local projects', () => {
    const root = fixture()
    const dir = join(root, 'packages/core/probe')
    mkdirSync(join(dir, 'leaf'))
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      references: [{}, { path: './missing.json' }, { path: './leaf' }],
    }))
    writeFileSync(join(dir, 'leaf/tsconfig.json'), JSON.stringify({
      references: [{ path: '../tsconfig.json' }, { path: '../../../other-package' }],
    }))
    expect(collectPackageInvariantViolations(root)).toEqual([{
      path: 'packages/core/probe/tsconfig.json',
      message: 'TypeScript project references must include ../../runtime-diagnostics/invariants',
    }])
  })

  it('reports absent project references when the config has no reference list', () => {
    const root = fixture()
    writeFileSync(join(root, 'packages/core/probe/tsconfig.json'), '{}')
    expect(collectPackageInvariantViolations(root).map(violation => violation.message))
      .toEqual(['TypeScript project references must include ../../runtime-diagnostics/invariants'])
  })

  it.each([
    '',
    'let install;',
    'const install = importedInstaller;',
    'const install = Object.assign();',
    'const install = Object.assign(existingInstaller, {});',
    'const install = Object.freeze(existingInstaller);',
  ])('rejects an installer whose local checking function cannot be inspected: %s', (declaration) => {
    const source = `
export const name = 'probe-invariant'
export const inject = ['invariants']
${declaration}
export const apply = (ctx) => ctx.invariants.register('@deepseek-ai/dsh-probe', install)
`
    expect(collectPackageInvariantViolations(fixture({ source })).map(violation => violation.message))
      .toEqual(['must declare a local install function for package-owned checks'])
  })

  it('reports every missing Loader export and an argument-free registration', () => {
    const source = 'ctx.invariants.register()\nexport {}\n;'
    const root = fixture({ source })
    const violations = collectPackageInvariantViolations(root)
    expect(violations.map(violation => violation.message)).toEqual([
      'line 1: ctx.invariants.register package name must resolve to a local string constant',
      'line 1: ctx.invariants.register must use the checked local install function',
      'must register exactly its own package name "@deepseek-ai/dsh-probe"; saw []',
      'must named-export name',
      'must named-export inject',
      'must named-export apply',
      'must declare a local install function for package-owned checks',
    ])
    expect(violations.map(violation => formatPackageInvariantViolation(root, violation)))
      .toEqual(violations.map(violation => `packages/core/probe/src/invariant.ts: ${violation.message}`))
  })

  it.each([
    ['empty arrow', 'const install = () => {}'],
    ['commented empty arrow', '/** No runtime invariant: this pure package owns no events or mutable data. */\nconst install = () => {}'],
    ['empty function', 'const install = function () {}'],
    ['commented body', 'const install = () => { /* No runtime invariant: this package has no mutable state. */ }'],
    ['injected empty arrow', "const install = Object.assign(() => {}, { inject: ['attachments'] })"],
  ])('rejects %s without accepting comment-based exemptions', (_label, declaration) => {
    const source = `
export const name = 'probe-invariant'
export const inject = ['invariants']
const PACKAGE_NAME = '@deepseek-ai/dsh-probe'
${declaration}
export const apply = (ctx: { invariants: { register(name: string, install: () => void): () => void } }) =>
  ctx.invariants.register(PACKAGE_NAME, install)
`
    expect(collectPackageInvariantViolations(fixture({ source }))).toEqual([{
      path: 'packages/core/probe/src/invariant.ts',
      message: 'install function must enforce a package-owned runtime contract; empty installers are prohibited',
    }])
  })
})
