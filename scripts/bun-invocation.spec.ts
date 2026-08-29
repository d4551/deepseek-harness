import { describe, expect, it } from 'vitest'
import { bunInvocation } from './bun-invocation.ts'

describe('bunInvocation', () => {
  it('spawns the bun entrypoint directly with the given arguments', () => {
    expect(bunInvocation(['run', 'build'], { npm_execpath: '/tools/bun' })).toEqual({
      command: '/tools/bun',
      args: ['run', 'build'],
    })
  })

  it('spawns a Windows bun entrypoint directly', () => {
    expect(bunInvocation(['x', 'vitest'], { npm_execpath: 'C:\\bun\\bun.exe' })).toEqual({
      command: 'C:\\bun\\bun.exe',
      args: ['x', 'vitest'],
    })
  })

  it('copies the arguments so a caller cannot mutate the returned array through its input', () => {
    const args = ['run', 'build']
    const invocation = bunInvocation(args, { npm_execpath: '/tools/bun' })
    args[1] = 'test'
    expect(invocation.args).toEqual(['run', 'build'])
  })

  it.each([
    ['undefined', undefined],
    ['empty', ''],
  ])('refuses an %s npm_execpath', (_label, entrypoint) => {
    expect(() => bunInvocation([], { npm_execpath: entrypoint }))
      .toThrow('npm_execpath is unavailable; invoke the script through bun run')
  })
})
