import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { REQUEST_BUDGET_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-session/types'
import { expect, it, onTestFinished } from 'vitest'
import { FileSettingsProvider } from '../../../settings/settings-file/src/index.ts'
import * as spine from '../src/index.ts'

it.each([
  undefined,
  { policyId: 'test/spine-request-budget', maxAgentAttempts: 7, maxRootAttempts: 23 },
])('preserves optional request policy through selection and real spine composition: %j', async (requestBudget) => {
  const directory = await mkdtemp(join(tmpdir(), 'spine-request-budget-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(FileSettingsProvider, { path: join(directory, 'settings.json'), watch: false })
  const config = spine.pickSpineConfig({
    dshHome: directory,
    workspaceContext: false,
    skills: { enabled: false },
    toolShell: false,
    toolJobs: false,
    ...requestBudget === undefined ? {} : { requestBudget },
  })
  expect(config.requestBudget).toEqual(requestBudget)
  expect(Object.hasOwn(config, 'requestBudget')).toBe(requestBudget !== undefined)
  const owner = await ctx.plugin(spine, config)
  await expect.poll(() => ctx.get('agentLoop')).toBeDefined()
  expect(ctx.agentLoop.config.requestBudget).toEqual(requestBudget)
  if (requestBudget === undefined) {
    expect(ctx.get('requestBudgetPolicy')).toBeUndefined()
  } else {
    await expect.poll(() => ctx.get('requestBudgetPolicy')).toBeDefined()
    expect(ctx.requestBudgetPolicy.get()).toEqual(requestBudget)
  }
  expect(ctx.settings.describe().some(row => row.ns === REQUEST_BUDGET_SETTINGS_NAMESPACE))
    .toBe(requestBudget !== undefined)
  expect(ctx.agents.list()).toEqual([])
  await owner.dispose()
  expect(ctx.get('requestBudgetPolicy')).toBeUndefined()
  expect(ctx.settings.describe()).toEqual([])
})
