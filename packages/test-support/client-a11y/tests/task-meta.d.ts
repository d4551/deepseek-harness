import type {} from 'vitest'

declare module 'vitest' {
  interface TaskMeta {
    /** Native surfaces validated at 100 by this test's own execution. */
    accessibilitySurfaces?: string[]
  }
}
