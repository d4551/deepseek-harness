import { describe, expect, it } from 'vitest'
import {
  createIntegrationRelease,
  integrationReleaseFiles,
  parseIntegrationReleaseControl,
  validateIntegrationReleaseControl,
  type IntegrationReleaseInput,
} from './integration-release-contract.ts'

function input(): IntegrationReleaseInput {
  const packageRecords = [
    { cpu: [], family: 'vendor' as const, file: 'packages/cordis.tgz', name: '@deepseek-ai/cordis', os: [], version: '4.0.1' },
    { cpu: [], family: 'dsh' as const, file: 'packages/dsh.tgz', name: '@deepseek-ai/dsh', os: [], version: '0.1.2-alpha.1' },
    { cpu: [], family: 'dsh' as const, file: 'packages/shell.tgz', name: '@deepseek-ai/dsh-tool-shell', os: [], version: '0.1.2-alpha.1' },
    { cpu: [], family: 'native' as const, file: 'packages/native.tgz', name: '@deepseek-ai/landlock-run', os: [], version: '0.1.0' },
    { cpu: ['x64'], family: 'native' as const, file: 'packages/native-linux-x64.tgz', name: '@deepseek-ai/landlock-run-linux-x64', os: ['linux'], version: '0.1.0' },
  ]
  return {
    files: [
      { bytes: Buffer.from('lock'), path: 'bun.lock' },
      { bytes: Buffer.from('{}\n'), path: 'package.json' },
      ...packageRecords.map(entry => ({ bytes: Buffer.from(entry.name), path: entry.file })),
    ],
    packages: packageRecords,
    runtime: {
      engine: '^22.19.0 || >=24.0.0',
      entry: { name: 'dsh', package: '@deepseek-ai/dsh', path: 'lib/bin.js', version: '0.1.2-alpha.1' },
      minimumExactMajor: 22,
      minimumExactMinor: 19,
      minimumMajor: 24,
      packageManager: 'bun@1.4.0',
      platform: 'linux-x64',
      toolPackage: '@deepseek-ai/dsh-tool-shell',
    },
    source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  }
}

describe('integration release contract', () => {
  it('binds canonical control bytes to every install member', () => {
    const release = createIntegrationRelease(input())
    const control = parseIntegrationReleaseControl(release.controlBytes)
    const files = integrationReleaseFiles(control, release.packBytes)

    expect(control.runtime.entry).toEqual({
      name: 'dsh',
      package: '@deepseek-ai/dsh',
      path: 'lib/bin.js',
      version: '0.1.2-alpha.1',
    })
    expect(files.get('packages/native-linux-x64.tgz')?.toString()).toBe('@deepseek-ai/landlock-run-linux-x64')
    expect(files.size).toBe(input().files.length)
  })

  it('rejects altered pack bytes', () => {
    const release = createIntegrationRelease(input())
    const altered = Buffer.from(release.packBytes)
    altered[0] = altered[0] === 0 ? 1 : 0

    expect(() => integrationReleaseFiles(release.control, altered)).toThrow(/pack identity differs/)
  })

  it('rejects an executable package that is absent from the DSH family', () => {
    const release = createIntegrationRelease(input())
    const control = structuredClone(release.control)
    if (!('runtime' in control) || typeof control.runtime !== 'object' || control.runtime === null) {
      throw new Error('fixture runtime is absent')
    }
    Object.assign(control.runtime, { entry: { name: 'dsh', package: '@deepseek-ai/missing', path: 'lib/bin.js', version: '0.1.2-alpha.1' } })

    expect(() => validateIntegrationReleaseControl(control)).toThrow(/DSH identity/)
  })

  it('rejects unbound pack members and noncanonical platform constraints', () => {
    const release = createIntegrationRelease(input())
    const control = structuredClone(release.control)
    if (!Array.isArray(control.packages) || typeof control.packages[0] !== 'object' || control.packages[0] === null) {
      throw new Error('fixture package inventory is absent')
    }
    Object.assign(control.packages[0], { cpu: ['x64', 'arm64'] })

    expect(() => createIntegrationRelease({
      ...input(),
      files: [...input().files, { bytes: Buffer.from('unbound'), path: 'unbound.txt' }],
    })).toThrow(/unbound members/)
    expect(() => validateIntegrationReleaseControl(control)).toThrow(/CPU list is not canonical/)
  })
})
