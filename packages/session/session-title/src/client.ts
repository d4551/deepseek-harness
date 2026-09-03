/**
 * Client-namespace projection of the title domain: a pure re-export of the package's
 * types outlet. Client code imports ONLY the client namespace (repo
 * discipline), so `./client` projects the same single-source content
 * `./types` serves to host consumers — zero duplication.
 *
 * @module @deepseek-ai/dsh-session-title/client
 */

// The projection-table augmentation lives in `./types.ts`; this seat carries
// it into the emitted declarations without forwarding an unnamed surface.
export type {} from './types.ts'
