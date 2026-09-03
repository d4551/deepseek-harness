# apps/web browser e2e

English | [中文](README.zh.md)

These tests boot the real web composition in-process and drive it with a real
Chromium over real HTTP. The lane's mechanics — modes, fixtures, goldens, and
the deliberate composition divergences from `dsh web` — are documented in
[`scaffold.ts`](scaffold.ts) and the
[browser e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).

## The `.client.` infix names the owning program

An unmarked file here type-checks in the root `tsconfig.host.json`, because the
browser e2e lane reads Host services directly: `ctx.connection`, the Host
`SessionStore`, and `ctx.sessionProjectionCache`. Driving a browser at runtime
does not make a file part of the Client program — the two faces merge cordis
`Context` under the same keys with different services, so one program cannot see
both. Moving an unmarked file into the Client aggregate makes every Host-service
access fail to compile.

A file that mounts the Client shell in-process carries a `.client.` infix and
type-checks in `apps/web/tsconfig.json` instead, the same marker
`packages/*/*/tests` uses. `tsconfig.host.json` excludes
`apps/web/tests/**/*.client.*` and includes everything else under this
directory, so membership follows the filename and neither config enumerates
files. [`scripts/web-program-partition.ts`](../../../scripts/web-program-partition.ts)
fails `bun run constraints` when an `apps/web` file reaches neither program or
both.

## Do not import `@deepseek-ai/dsh-client-*` here

Importing a Client package — a value or a type — pulls its whole TypeScript
project, and every project it references, into the **Host build graph**. That has
bitten this lane once already: four Client consumer packages reference
`api/remotes`' Client face, which cannot compile until Host tsdown has generated
`@deepseek-ai/dsh-goal/remote`, so the Host build phase ended up waiting on an
artifact it produces itself.

When a scenario needs a Client-owned constant or pure function, mirror it here
instead, next to the commented-out import that names the source module. A drift
then surfaces as a missed selector or a stale mirrored value — a loud failure,
never a silent pass. `scaffold.ts` follows this rule for the welcome-notice
namespace, acknowledgement field, version, and asserted Chinese copy.

One kind of Client import stands, and the infix is what licenses it.
`assembled-boot.client.ts` drives the shell itself, so it imports `AppWebEntry`
from `@deepseek-ai/dsh-client-web` and the boot-manifest type from
`@deepseek-ai/dsh-client-modules/client`; booting the real shell is what that
harness is for, and it and its nine `*.client.expected.e2e.ts` consumers sit in
the Client program, where those packages already are. The chat scenarios mirror
`conversationContextKey` in `support.ts` instead of importing its Client owner.

Nothing mechanically enforces the mirroring rule; keep it in review. The program
split itself is enforced: an unmarked file that imports a Client package pulls
that package's project into the Host graph and the Host build fails.
