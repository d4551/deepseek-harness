import { describe, expect, it } from 'vitest'
import * as ModelsInvariant from '@deepseek-ai/dsh-client-ui-settings-models/invariant'
import { assertInvariantCompanion } from '@deepseek-ai/dsh-client-test-runtime/src/invariant-companion.ts'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionProps } from '../src/client/ModelsSection.tsx'

assertInvariantCompanion(
  ModelsInvariant,
  import('@deepseek-ai/dsh-client-ui-settings-models'),
)

describe('ModelsSection', () => {
  it('renders null until the shell injects the section dependencies', () => {
    expect(ModelsSection({} as ModelsSectionProps)).toBeNull()
  })
})
