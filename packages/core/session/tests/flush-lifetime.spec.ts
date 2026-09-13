import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'

it('starts every durability listener synchronously and preserves its exact failure after settlement', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const failure = { code: 'STORAGE_WRITE_DENIED' }
  const gate = Promise.withResolvers<undefined>()
  const invoked: number[] = []
  ctx.on('session/flush', () => {
    invoked.push(1)
    throw failure
  })
  ctx.on('session/flush', () => {
    invoked.push(2)
    return gate.promise
  })

  let settled = false
  const flushing = ctx.sessions.flush(session)
  const observation = flushing.then(
    () => { settled = true },
    () => { settled = true },
  )
  expect(invoked).toEqual([1, 2])
  await Promise.resolve()
  expect(settled).toBe(false)

  gate.resolve(undefined)
  await expect(flushing).rejects.toBe(failure)
  await observation
  expect(settled).toBe(true)
})
