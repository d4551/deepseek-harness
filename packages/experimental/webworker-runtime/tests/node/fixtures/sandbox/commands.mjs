/** Production sandbox compositions executed inside the packed Worker image. */
import { existsSync, readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const WORKSPACE = '/dsh/workspace'
const OUTSIDE = '/dsh/home'

/** @param {'read-only' | 'workspace-write' | 'danger-full-access'} mode */
async function setup(mode) {
  const ctx = new Context()
  await ctx.plugin(LocalSandboxProvider)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: WORKSPACE })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxBashExecutor, { cwd: WORKSPACE })
  return ctx
}

async function workspaceWrites() {
  const ctx = await setup('workspace-write')
  try {
    const bash = ctx.shell
    const allowed = await bash.run(bash.resolve({
      command: `echo workspace > ${WORKSPACE}/allowed.txt; echo temp > /tmp/allowed.txt`,
    }))
    const denied = await bash.run(bash.resolve({ command: `echo denied > ${OUTSIDE}/denied.txt` }))
    return {
      allowed: allowed.sandbox,
      workspace: readFileSync(`${WORKSPACE}/allowed.txt`, 'utf8'),
      temp: readFileSync('/dsh/tmp/allowed.txt', 'utf8'),
      denied: denied.sandbox,
      deniedExitCode: denied.exitCode,
      outsideExists: existsSync(`${OUTSIDE}/denied.txt`),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function accessModes() {
  const ctx = await setup('read-only')
  try {
    const bash = ctx.shell
    const strict = await bash.run(bash.resolve({
      command: `echo discarded > /dev/null; echo denied > ${WORKSPACE}/strict.txt`,
    }))
    const unrestricted = await setup('danger-full-access')
    try {
      const full = unrestricted.shell
      const allowed = await full.run(full.resolve({ command: `echo allowed > ${OUTSIDE}/full.txt` }))
      return {
        strict: strict.sandbox,
        strictExists: existsSync(`${WORKSPACE}/strict.txt`),
        allowed: allowed.sandbox,
        outside: readFileSync(`${OUTSIDE}/full.txt`, 'utf8'),
      }
    } finally {
      await unrestricted.fiber.dispose()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function concurrentPolicies() {
  const ctx = await setup('read-only')
  try {
    const bash = ctx.shell
    const strict = bash.run(bash.resolve({
      command: `sleep 0.02; echo denied > ${WORKSPACE}/strict.txt`,
    }))
    const writable = bash.run(bash.resolve({
      command: `echo allowed > ${WORKSPACE}/writable.txt`,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: WORKSPACE },
    }))
    const [strictResult, writableResult] = await Promise.all([strict, writable])
    return {
      strict: strictResult.sandbox,
      writable: writableResult.sandbox,
      strictExists: existsSync(`${WORKSPACE}/strict.txt`),
      workspace: readFileSync(`${WORKSPACE}/writable.txt`, 'utf8'),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function run() {
  switch (process.argv[2]) {
    case 'workspace': return await workspaceWrites()
    case 'modes': return await accessModes()
    case 'concurrent': return await concurrentPolicies()
    default: throw new Error(`Unknown sandbox scenario: ${String(process.argv[2])}`)
  }
}

export const result = run()
