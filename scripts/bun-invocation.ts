/** Resolve shell-free child-process invocations for the bun process that launched a package script. */

/**
 * Resolve bun's executable and arguments from its lifecycle environment.
 *
 * Bun always reports its own binary in `npm_execpath`, so the entrypoint is
 * spawned directly and never needs a Node interpreter in front of it.
 * @param args - Arguments to pass to bun.
 * @param environment - Lifecycle environment containing `npm_execpath`.
 * @returns A command and argument array suitable for `spawn` or `spawnSync` without a shell.
 */
export function bunInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const entrypoint = environment.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('bun invocation: npm_execpath is unavailable; invoke the script through bun run.')
  }
  return { command: entrypoint, args: [...args] }
}
