import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { createProcessShutdown } from '../../src/process-shutdown.ts'

const [scenario, codeArgument] = process.argv.slice(2)
const code = Number(codeArgument)
if (!Number.isInteger(code) || code < 0 || code > 255) throw new Error('invalid process exit code')

const events = []
process.once('exit', (exitCode) => {
  writeSync(1, `${JSON.stringify({ exitCode, events })}\n`)
})

switch (scenario) {
  case 'complete': {
    const shutdown = createProcessShutdown(async () => {
      await delay(1)
      events.push('disposed')
    })
    await shutdown.shutdown(code)
    events.push(`exitCode:${process.exitCode}`)
    await delay(10)
    events.push('drained')
    break
  }
  case 'reject':
  case 'reject-interrupt':
  case 'throw': {
    const shutdown = createProcessShutdown(() => {
      events.push('disposing')
      const error = new Error('disposal failure from child')
      if (scenario === 'throw') throw error
      return Promise.reject(error)
    })
    if (scenario === 'reject-interrupt') shutdown.interrupt(code)
    await shutdown.shutdown(code)
    events.push('continued after failed disposal')
    break
  }
  case 'deadline': {
    const shutdown = createProcessShutdown(async () => {
      events.push('disposing')
      await delay(60_000)
      events.push('disposed')
    })
    await shutdown.shutdown(code)
    events.push('continued after deadline')
    break
  }
  case 'interrupt-complete': {
    const shutdown = createProcessShutdown(async () => {
      events.push('disposing')
      await delay(1)
      events.push('disposed')
    })
    shutdown.interrupt(code)
    await shutdown.shutdown(7)
    events.push('continued after interrupt')
    break
  }
  case 'coalesce': {
    const disposal = Promise.withResolvers()
    const shutdown = createProcessShutdown(async () => {
      events.push('disposing')
      await disposal.promise
      events.push('disposed')
    })
    const first = shutdown.shutdown(code)
    const second = shutdown.shutdown(143)
    assert.equal(first, second)
    disposal.resolve()
    await first
    await shutdown.shutdown(130)
    events.push(`exitCode:${process.exitCode}`)
    break
  }
  case 'escalate-normal':
  case 'escalate-interrupt': {
    const entered = Promise.withResolvers()
    const shutdown = createProcessShutdown(async () => {
      events.push('disposing')
      entered.resolve()
      await delay(60_000)
      events.push('disposed')
    })
    if (scenario === 'escalate-interrupt') shutdown.interrupt(code)
    const pending = shutdown.shutdown(code)
    await entered.promise
    events.push('escalating')
    shutdown.interrupt(130)
    await pending
    events.push('continued after escalation')
    break
  }
  case 'interrupt-after-complete': {
    const shutdown = createProcessShutdown(async () => {
      await delay(1)
      events.push('disposed')
    })
    await shutdown.shutdown(code)
    events.push(`exitCode:${process.exitCode}`)
    shutdown.interrupt(130)
    events.push('continued after interrupt')
    break
  }
  default:
    throw new Error(`invalid shutdown scenario: ${scenario}`)
}
