import * as SidebarInvariant from '@deepseek-ai/dsh-client-ui-sidebar/invariant'
import { assertInvariantCompanion } from '@deepseek-ai/dsh-client-test-runtime/src/invariant-companion.ts'

assertInvariantCompanion(
  SidebarInvariant,
  import('@deepseek-ai/dsh-client-ui-sidebar'),
)
