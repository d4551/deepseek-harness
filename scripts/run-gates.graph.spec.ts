import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultConcurrency, gatesForMode } from './run-gates.ts'
import { withBunEntrypoint, withEnv } from './run-gates.spec-helpers.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Oxlint gate', () => {
  it('uses the package script when no worker bound is configured', () => {
    const subject = withEnv('DSH_OXLINT_THREADS', undefined, () =>
      withBunEntrypoint(() => gatesForMode('ci-lint-contracts-ready')[0]))

    expect(subject).toMatchObject({
      id: 'lint',
      displayCommand: 'bun run lint:contracts-ready',
      command: '/private/bun',
      args: ['run', 'lint:contracts-ready'],
    })
  })

  it('surfaces the configured worker bound on the shared package script', () => {
    const subject = withEnv('DSH_OXLINT_THREADS', '4', () =>
      withBunEntrypoint(() => gatesForMode('ci-lint-contracts-ready')[0]))

    expect(subject).toMatchObject({
      id: 'lint',
      displayCommand: 'DSH_OXLINT_THREADS=4 bun run lint:contracts-ready',
      command: '/private/bun',
      args: ['run', 'lint:contracts-ready'],
    })
  })
})

describe('mutation ratchet', () => {
  it('runs in the aggregates CI and a local full check execute', () => {
    // A recorded threshold that nothing executes is a number, not a ratchet.
    for (const mode of ['ci-primary', 'ci-linux-primary', 'check-all'] as const) {
      const gates = withBunEntrypoint(() => gatesForMode(mode))
      expect(gates.map(gate => gate.id), `${mode} must run the mutation gate`).toContain('mutation')

      // The gate covers packages/util only. A label reading "mutation score"
      // in a CI aggregate reports the repository's score, which this is not,
      // so the label has to carry the tier it measures.
      const mutation = gates.find(gate => gate.id === 'mutation')
      expect(mutation?.label, `${mode} must name the tier the mutation gate covers`)
        .toBe('mutation score (util tier)')
    }
  })
})

describe('Typert contract preparation', () => {
  it('prepares primary source consumers once before they run', () => {
    const subject = withEnv('DSH_OXLINT_THREADS', undefined, () =>
      withBunEntrypoint(() => gatesForMode('ci-primary')))

    expect(subject.find(item => item.id === 'typert-contracts')).toMatchObject({
      displayCommand: 'bun run build:lib:host',
      command: '/private/bun',
      args: ['run', 'build:lib:host'],
    })
    for (const [id, script] of [
      ['typecheck', 'typecheck:contracts-ready'],
      ['lint', 'lint:contracts-ready'],
      ['doc-typecheck', 'doc-typecheck:contracts-ready'],
    ] as const) {
      expect(subject.find(item => item.id === id)).toMatchObject({
        displayCommand: `bun run ${script}`,
        command: '/private/bun',
        args: ['run', script],
        needs: ['typert-contracts'],
      })
    }
    expect(subject.find(item => item.id === 'build')?.needs).toEqual([
      'typecheck',
      'lint',
      'doc-typecheck',
    ])
  })

  it('reuses contracts from the validated consumer build', () => {
    const subject = withBunEntrypoint(() => gatesForMode('ci-consumers'))

    expect(subject.find(item => item.id === 'lint-and-duplication')).toMatchObject({
      displayCommand: 'bun run check:ci:lint:contracts-ready',
      command: '/private/bun',
      args: ['run', 'check:ci:lint:contracts-ready'],
    })
    expect(subject.find(item => item.id === 'doc-typecheck')).toMatchObject({
      displayCommand: 'bun run doc-typecheck:contracts-ready',
      command: '/private/bun',
      args: ['run', 'doc-typecheck:contracts-ready'],
    })
  })

  it('keeps standalone doc sync responsible for preparation', () => {
    const docTypecheck = withBunEntrypoint(() =>
      gatesForMode('doc-sync').find(item => item.id === 'doc-typecheck'))

    expect(docTypecheck?.displayCommand).toBe('bun run doc-typecheck')
  })
})

describe('Node compatibility graph', () => {
  it('runs the jsdom environment smoke on every advertised Node line', () => {
    const subject = withBunEntrypoint(() => gatesForMode('node-compat'))

    expect(subject.find(item => item.id === 'vitest-jsdom-smoke')).toMatchObject({
      label: 'Vitest jsdom smoke',
      args: [
        'x',
        'vitest',
        'run',
        'scripts/vitest-environment.compat.spec.ts',
      ],
    })
  })
})

describe('Node 24 lane ownership', () => {
  it('keeps the static lane source-only', () => {
    const subject = withBunEntrypoint(() => gatesForMode('ci-static'))

    expect(subject.map(item => item.id)).not.toContain('build')
    expect(subject.map(item => item.id)).not.toContain('doc-typecheck')
  })

  it('owns the build and orders its artifact consumers', () => {
    const subject = withBunEntrypoint(() => gatesForMode('ci-consumers'))

    expect(defaultConcurrency('ci-consumers', subject.length, 4)).toEqual({
      workers: 11,
      source: 'ci-consumers gate count',
    })
    expect(subject.map(item => item.id)).toEqual([
      'build',
      'node-compat',
      'publint',
      'built-package-invariants',
      'lint-and-duplication',
      'snapshot',
      'expected-output',
      'web-snapshot',
      'doc-typecheck',
      'node-next-types',
      'built-bin-smoke',
    ])
    expect(subject.find(item => item.id === 'publint')?.needs).toEqual(['build'])
    expect(subject.find(item => item.id === 'build')?.env).toEqual({
      DSH_BUILD_CLIENT_PROFILE: 'official',
    })
    expect(subject.find(item => item.id === 'node-compat')?.env).toEqual({
      DSH_BUILD_CLIENT_PROFILE: 'official',
    })
    expect(subject.find(item => item.id === 'built-package-invariants')?.needs).toEqual(['build'])
    expect(subject.find(item => item.id === 'lint-and-duplication')?.needs).toEqual(['built-package-invariants'])
    for (const id of [
      'snapshot',
      'expected-output',
      'web-snapshot',
      'doc-typecheck',
      'node-next-types',
      'built-bin-smoke',
    ]) {
      expect(subject.find(item => item.id === id)?.needs).toEqual(['built-package-invariants'])
    }
    expect(subject.find(item => item.id === 'snapshot')?.env).toEqual({ DSH_EXAMPLE_MODE: 'lib' })
    expect(subject.find(item => item.id === 'expected-output')?.env).toEqual({ DSH_EXAMPLE_MODE: 'lib' })
    expect(subject.find(item => item.id === 'doc-typecheck')?.env).toEqual({
      DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1',
    })
    expect(subject.find(item => item.id === 'built-bin-smoke')?.args).toEqual(
      expect.arrayContaining([
        'packages/subagent/subagent-codex/tests/loader-composition.e2e.ts',
        'packages/subagent/subagent-claude-code/tests/loader-composition.e2e.ts',
        'packages/experimental/agent-team/tests/built-lib.e2e.ts',
      ]),
    )
    expect(subject.find(item => item.id === 'web-snapshot')).toMatchObject({
      displayCommand: 'DSH_SNAPSHOT=replay bun run test:web:built',
      env: { DSH_SNAPSHOT: 'replay' },
      after: [
        'publint',
        'lint-and-duplication',
        'snapshot',
        'expected-output',
        'doc-typecheck',
        'node-next-types',
        'built-bin-smoke',
      ],
    })
  })
})

describe('Linux primary graph', () => {
  it('adds the same compare-only web gate after built client artifacts', () => {
    const subject = withBunEntrypoint(() => gatesForMode('ci-linux-primary'))
    const web = subject.find(item => item.id === 'web-snapshot')

    expect(web).toMatchObject({
      displayCommand: 'DSH_SNAPSHOT=replay bun run test:web:built',
      env: { DSH_SNAPSHOT: 'replay' },
      needs: ['built-package-invariants'],
    })
  })
})
