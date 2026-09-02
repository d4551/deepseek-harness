/**
 * Portable hook programs and host shell for the bridge suites.
 *
 * A configured hook is a command line the bridge hands to `ctx.shell`, and
 * which shell that is depends on the host: PowerShell on Windows, bash
 * everywhere else. A suite that writes `#!/usr/bin/env bash` scripts therefore
 * tests the bridge only on POSIX — and the hooks bridge is not bash-specific.
 *
 * Every hook here is a Node program invoked as `node "<path>"`, a command line
 * both dialects parse the same way, and each body is written against the
 * prelude below instead of against shell syntax.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Helpers every hook body may use, prepended to the program file. They cover
 * exactly what the suites' hooks do: write framed stdout/stderr, read the
 * trusted stdin payload, touch or capture a file, and stay alive.
 */
const PRELUDE = `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const out = text => { process.stdout.write(text + '\\n') }
const err = text => { process.stderr.write(text + '\\n') }
const errRaw = text => { process.stderr.write(text) }
const readStdin = () => readFileSync(0, 'utf8')
const capture = path => { writeFileSync(path, readStdin()) }
const write = (path, text) => { writeFileSync(path, text) }
const touch = path => { writeFileSync(path, '') }
const exists = path => existsSync(path)
const sleep = seconds => { setTimeout(() => {}, seconds * 1000) }
`

/**
 * Write one hook program and return the command line that runs it under any
 * host shell.
 *
 * `node` stays bare so both dialects resolve it through PATH; the script path
 * is double-quoted, which bash and PowerShell read identically for the
 * temp-directory paths these suites produce.
 * @param dir - directory the program is written into.
 * @param name - program name, without extension.
 * @param body - program body, written against the prelude helpers.
 * @returns the hook `command` to configure.
 */
export function hookProgram(dir: string, name: string, body: string): string {
  const path = join(dir, `${name}.mjs`)
  writeFileSync(path, PRELUDE + body)
  return `node "${path}"`
}

/**
 * Mount the shell executor this host actually runs hooks through, so a bridge
 * suite exercises the same `ctx.shell` the product mounts here.
 * @param ctx - the context the executor is mounted on.
 * @param config - executor configuration (the suites set a timeout, and sometimes a default working directory).
 * @returns resolution once the executor is mounted.
 */
export async function plugHostShell(ctx: Context, config: { timeoutMs: number; cwd?: string }): Promise<void> {
  if (process.platform === 'win32') {
    const { PwshLocalExecutor } = await import('@deepseek-ai/dsh-pwsh-local')
    await ctx.plugin(PwshLocalExecutor, config)
    return
  }
  const { LocalBashExecutor } = await import('@deepseek-ai/dsh-bash-local')
  await ctx.plugin(LocalBashExecutor, config)
}
