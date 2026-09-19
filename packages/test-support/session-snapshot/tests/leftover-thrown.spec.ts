import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { launchAcpTestAgent, type AgentUnderTest } from '../src/launcher.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

const fakeAgent = fileURLToPath(new URL('./fixtures/fake-acp-agent.ts', import.meta.url))
const AGENT: AgentUnderTest = {
  binScript: fakeAgent,
  libBinScript: fakeAgent,
  configPath: fakeAgent,
  tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
}

const leftoverDirs: string[] = []
afterAll(async () => {
  for (const dir of leftoverDirs) await rm(dir, { recursive: true, force: true })
})

async function leftoverWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'acp-leftover-thrown-'))
  leftoverDirs.push(dir)
  await writeFile(join(dir, 'behavior.json'), JSON.stringify({}))
  return dir
}

const leftoverReasons: Thrown[] = [
  { leftover: true },
  'leftover string',
  0,
  false,
  1n,
  Symbol.for('leftover-wait'),
  null,
  undefined,
]

describe('leftover Promise reject arms', () => {
  it('preserves leftover Thrown waitForUpdate predicate refuses', { timeout: 20_000 }, async () => {
    const dir = await leftoverWorkspace()
    const launched = launchAcpTestAgent({ agent: AGENT, cwd: dir })
    await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await launched.client.newSession({ cwd: dir, mcpServers: [] })
    const claimed = leftoverReasons.map(reason =>
      launched.waitForUpdate(() => { throw reason }).catch((error: unknown): unknown => error),
    )
    await launched.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(await Promise.all(claimed)).toEqual(leftoverReasons)
    await launched.close()
  })
})
