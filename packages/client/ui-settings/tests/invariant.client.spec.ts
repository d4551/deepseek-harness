import * as SettingsInvariant from '@deepseek-ai/dsh-client-ui-settings/invariant'
import { assertInvariantCompanion } from '@deepseek-ai/dsh-client-test-runtime/src/invariant-companion.ts'

assertInvariantCompanion(
  SettingsInvariant,
  import('@deepseek-ai/dsh-client-ui-settings'),
)
