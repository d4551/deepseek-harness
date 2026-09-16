import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('native skill discovery failures', () => {
  it.each([false, true])('retries a cyclic skill root after filesystem repair with watch=%s', async (watch) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-skill-native-'))
    directories.push(directory)
    const root = join(directory, 'skills')
    const peer = join(directory, 'cycle')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(peer, root, linkType)
    await symlink(root, peer, linkType)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false,
      customSkillDirs: [root],
      watch,
    })

    expect(await ctx.skills.snapshot()).toEqual({ skills: [], complete: false })

    await rm(root)
    await rm(peer)
    await mkdir(root)
    await writeFile(join(root, 'recovered.md'), '---\nname: recovered\ndescription: Recovered directory\n---\n\nDurable skill body.\n')

    expect(await ctx.skills.snapshot()).toMatchObject({
      skills: [{ name: 'recovered', description: 'Recovered directory' }],
      complete: true,
    })
    expect(await ctx.skills.get('recovered')).toMatchObject({ content: 'Durable skill body.' })
    await fiber.dispose()
    expect(await ctx.skills.snapshot()).toEqual({ skills: [], complete: true })
  })
})
