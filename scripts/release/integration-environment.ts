import { delimiter } from 'node:path'

/** Keep release subprocesses on the retained Node and Bun executables. */
export function integrationEnvironment(tools: string, bun: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    npm_execpath: bun,
    PATH: [tools, process.env.PATH ?? ''].join(delimiter),
  }
}
