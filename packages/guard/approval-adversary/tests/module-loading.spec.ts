/** Public entrypoints must load before a host can mount its approval chain. */

import { expect, it } from 'vitest'

it('loads the adversarial reviewer with its registered settings identity', async () => {
  const plugin = await import('../src/index.ts')
  expect(plugin.APPROVAL_ADVERSARY_SETTINGS_NAMESPACE).toBe('approval-adversary')
  expect(plugin.name).toBe('approval-adversary')
  expect(plugin.inject).toEqual(['approval', 'llm'])
})

it('loads the mandatory assessor with its registered settings identity', async () => {
  const plugin = await import('@deepseek-ai/dsh-approval-assessor')
  expect(plugin.APPROVAL_ASSESSOR_SETTINGS_NAMESPACE).toBe('approval-assessor')
  expect(plugin.name).toBe('approval-assessor')
  expect(plugin.inject).toEqual(['approval'])
})
