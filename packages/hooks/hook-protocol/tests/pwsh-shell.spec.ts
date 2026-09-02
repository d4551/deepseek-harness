/**
 * A hook running through a PowerShell-backed `ctx.shell` — the executor the
 * shipped Windows presets mount.
 *
 * The hooks bridge is not bash-specific: `runHook` hands the configured command
 * to whatever executor is mounted, so on Windows the hook's stdin payload,
 * stdout decode, stderr capture, and exit-code contract all travel through
 * `pwsh -Command`. This suite is the one place that proves it, so it must not
 * be skipped on Windows: PowerShell ships with the operating system, and a
 * probe failure there is a broken host rather than an absent shell.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import PwshLocalExecutor, { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import { runHook } from '@deepseek-ai/dsh-hook-protocol'
import { hookProgram } from './hook-program.ts'

const isWin32 = process.platform === 'win32'

const pwshProbe = spawnSync(
  resolvePwshPath(),
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'],
  { encoding: 'utf8' },
)

// A POSIX host without PowerShell cannot run these; Windows always can, so a
// failing probe there falls through and fails loudly at the first command.
const skip = !isWin32 && pwshProbe.status !== 0

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hook-pwsh-'))
  dirs.push(dir)
  return dir
}

async function pwshShell(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(PwshLocalExecutor, { timeoutMs: 30_000 })
  return ctx
}

describe.skipIf(skip)('a hook run through a pwsh ctx.shell', () => {
  it('delivers the stdin payload and decodes the hook\'s structured stdout', async () => {
    const ctx = await pwshShell()
    const dir = tempDir()
    const captured = join(dir, 'payload.json')
    const command = hookProgram(dir, 'context', [
      `capture(${JSON.stringify(captured)})`,
      'out(\'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"from pwsh"}}\')',
    ].join('\n') + '\n')

    const result = await runHook(
      ctx.shell,
      { command },
      {
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        signal: new AbortController().signal,
        trailingNewline: true,
        defaultTimeoutMs: 30_000,
        expectedEventName: 'UserPromptSubmit',
      },
      () => 0,
    )

    expect(result.output.exitCode).toBe(0)
    expect(result.output.additionalContext).toBe('from pwsh')
    const { readFileSync } = await import('node:fs')
    expect(JSON.parse(readFileSync(captured, 'utf8'))).toEqual({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'go',
    })
  }, 60_000)

  it('carries a blocking exit code and its stderr reason back out of PowerShell', async () => {
    const ctx = await pwshShell()
    const dir = tempDir()
    const command = hookProgram(dir, 'deny', 'err(\'denied by policy\')\nprocess.exit(2)\n')

    const result = await runHook(
      ctx.shell,
      { command },
      {
        payload: { hook_event_name: 'PreToolUse' },
        signal: new AbortController().signal,
        trailingNewline: true,
        defaultTimeoutMs: 30_000,
      },
      () => 0,
    )

    expect(result.output.exitCode).toBe(2)
    expect(result.output.stderr).toContain('denied by policy')
  }, 60_000)

  it('applies the trusted environment entries the bridge supplies', async () => {
    const ctx = await pwshShell()
    const dir = tempDir()
    const command = hookProgram(dir, 'env', 'out(process.env.CLAUDE_PROJECT_DIR ?? "unset")\n')

    const result = await runHook(
      ctx.shell,
      { command },
      {
        payload: {},
        env: { CLAUDE_PROJECT_DIR: dir },
        signal: new AbortController().signal,
        trailingNewline: false,
        defaultTimeoutMs: 30_000,
      },
      () => 0,
    )

    expect(result.output.exitCode).toBe(0)
    expect(result.output.stdout.trim()).toBe(dir)
  }, 60_000)
})
