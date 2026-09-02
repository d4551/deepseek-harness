// One-shot: removes the superseded web-fetch-playwright suite entry.
// The suite's 31 tests were split into provider.spec.ts, policy.spec.ts, and
// plugin.spec.ts (verified green); this deletes the old spec file that now
// only re-imports those suites and double-executes them.
import { rmSync } from 'node:fs'

rmSync('packages/web/web-fetch-playwright/tests/fetch-playwright.spec.ts')
