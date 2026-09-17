import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const driver = fileURLToPath(new URL('./fixtures/process-shutdown.mjs', import.meta.url))

describe('native process shutdown', () => {
  it.each([0, 7])('drains pending work before natural exit with code %s', async (code) => {
    const result = await execa(process.execPath, ['--import', 'tsx', driver, 'complete', String(code)], {
      reject: false,
      timeout: 3_000,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode).toBe(code)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      exitCode: code,
      events: ['disposed', `exitCode:${code}`, 'drained'],
    })
  })

  it.each([
    ['reject', 0, 1],
    ['reject', 7, 7],
    ['reject-interrupt', 0, 1],
    ['reject-interrupt', 143, 143],
    ['throw', 0, 1],
  ])('reports %s disposal with requested code %s as failure %s', async (scenario, requested, expected) => {
    const result = await execa(process.execPath, ['--import', 'tsx', driver, scenario, String(requested)], {
      reject: false,
      timeout: 3_000,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode).toBe(expected)
    expect(result.stderr).toContain('dsh: application disposal failed Error: disposal failure from child')
    expect(JSON.parse(result.stdout)).toEqual({ exitCode: expected, events: ['disposing'] })
  })

  it.each([[0, 1], [143, 143]])('reports deadline with requested code %s as failure %s', async (requested, expected) => {
    const result = await execa(process.execPath, ['--import', 'tsx', driver, 'deadline', String(requested)], {
      reject: false,
      timeout: 10_000,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode).toBe(expected)
    expect(result.durationMs).toBeGreaterThanOrEqual(5_000)
    expect(result.stderr).toBe('dsh: application disposal exceeded 5000ms')
    expect(JSON.parse(result.stdout)).toEqual({ exitCode: expected, events: ['disposing'] })
  })

  it.each([0, 143])('drains the first interrupt before exiting with code %s', async (code) => {
    const result = await execa(process.execPath, ['--import', 'tsx', driver, 'interrupt-complete', String(code)], {
      reject: false,
      timeout: 3_000,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode).toBe(code)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ exitCode: code, events: ['disposing', 'disposed'] })
  })

  it.each([0, 7])('coalesces shutdown promises and retains the first exit code %s', async (code) => {
    const result = await execa(process.execPath, ['--import', 'tsx', driver, 'coalesce', String(code)], {
      reject: false,
      timeout: 3_000,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode).toBe(code)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ exitCode: code, events: ['disposing', 'disposed', `exitCode:${code}`] })
  })

  it.each(['escalate-normal', 'escalate-interrupt'])('forces exit during pending disposal: %s', async (scenario) => {
    const result = await execa(process.execPath, ['--import', 'tsx', driver, scenario, '0'], {
      reject: false,
      timeout: 3_000,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode).toBe(130)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ exitCode: 130, events: ['disposing', 'escalating'] })
  })

  it('forces an interrupt while natural completion drains the process', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx', driver, 'interrupt-after-complete', '0'], {
      reject: false,
      timeout: 3_000,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode).toBe(130)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ exitCode: 130, events: ['disposed', 'exitCode:0'] })
  })
})
