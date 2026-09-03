import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectWebProgramPartitionViolations } from './web-program-partition.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Build a repository whose `apps/web` files split across the two aggregates by
 * the `.client.` infix, exactly as the real configs do.
 */
function partitionFixture(options: {
  readonly files: readonly string[]
  readonly hostInclude: readonly string[]
  readonly hostExclude: readonly string[]
  readonly webInclude: readonly string[]
}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-program-partition-'))
  roots.push(root)
  mkdirSync(join(root, 'apps/web/tests'), { recursive: true })
  mkdirSync(join(root, 'apps/web/src'), { recursive: true })
  for (const file of options.files) writeFileSync(join(root, file), 'export const marker = 1\n')
  writeJson(join(root, 'apps/web/tsconfig.json'), { include: options.webInclude })
  writeJson(join(root, 'tsconfig.host.json'), {
    include: options.hostInclude,
    exclude: options.hostExclude,
  })
  writeJson(join(root, 'tsconfig.client.json'), {
    files: [],
    references: [{ path: './apps/web' }],
  })
  return root
}

const HOST_INCLUDE = ['apps/web/tests/**/*.ts'] as const
const HOST_EXCLUDE = ['apps/web/tests/**/*.client.*'] as const
const WEB_INCLUDE = ['src', 'tests/**/*.client.*', 'vite.config.ts'] as const
const FILES = [
  'apps/web/src/main.ts',
  'apps/web/tests/scaffold.ts',
  'apps/web/tests/mount.client.ts',
  'apps/web/vite.config.ts',
] as const

describe('apps/web program partition', () => {
  it('accepts a total partition split by the `.client.` infix', () => {
    const root = partitionFixture({
      files: FILES,
      hostInclude: HOST_INCLUDE,
      hostExclude: HOST_EXCLUDE,
      webInclude: WEB_INCLUDE,
    })

    expect(collectWebProgramPartitionViolations(root)).toEqual([])
  })

  it('rejects a file no program checks', () => {
    const root = partitionFixture({
      files: FILES,
      hostInclude: HOST_INCLUDE,
      hostExclude: HOST_EXCLUDE,
      // Drops the application build config, which no other include covers.
      webInclude: ['src', 'tests/**/*.client.*'],
    })

    expect(collectWebProgramPartitionViolations(root)).toEqual([
      'apps/web/vite.config.ts: checked by no program; give it the `.client.` infix to join the Client program, or leave it unmarked for the Host program',
    ])
  })

  it('rejects a file both programs check', () => {
    const root = partitionFixture({
      files: FILES,
      hostInclude: HOST_INCLUDE,
      // Drops the infix exclusion, so the Host include swallows the Client file.
      hostExclude: [],
      webInclude: WEB_INCLUDE,
    })

    expect(collectWebProgramPartitionViolations(root)).toEqual([
      'apps/web/tests/mount.client.ts: checked by both the Host and Client programs; one program cannot hold both sides of the cordis Context merges',
    ])
  })
})
