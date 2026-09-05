# Agent Note: Live-stack and toolchain floors share one latest-stable triple

Status: implemented

[English](2026-09-06-live-stack-toolchain-floor-agreement.md) | 中文

## Problem

两套下限收集器可以点名同一条工具链却彼此不一致，而且不会失败。[`scripts/live-stack-floors.ts`](../../../../scripts/live-stack-floors.ts) 把 vitest 与 `@vitest/coverage-v8` 钉在 4.1.11，而根目录清单与 [`scripts/verify-toolchain-floors.ts`](../../../../scripts/verify-toolchain-floors.ts) 已经要求 vitest 5。一棵已经交付 `^5.0.0` 的树会让两套收集器都通过，于是 live-stack 里过时的数字看不见。live-stack 收集器也不读取 `packageManager`，因此 bun 1.3.x 不会让该 spec 失败。

## Decision

[`LIVE_TOOLCHAIN_FLOORS`](../../../../scripts/live-stack-floors.ts) 是两套收集器共享名称（TypeScript、Vite、React、react-dom、Playwright、vitest、tsx）的 SemVer 来源。`TOOLCHAIN_FLOORS` 是该表的 (major, minor) 投影，不得重写这些数字。`@vitest/coverage-v8` 使用 `VITEST_FLOOR`，而不是第二个三元组。`BUN_PIN` 为 `bun@1.4.2`，两套收集器都把根目录 `packageManager` 字段与这一精确拼写比较。

[`collectorFloorDisagreements`](../../../../scripts/live-stack-floors.ts) 会让一套收集器会接受、另一套会拒绝的注入对失败（vitest 4.1.11 对 [5, 0]）。现场 spec 读取根目录与 `apps/web` 清单，以及已安装的 `vitest` / `@vitest/coverage-v8` 的 package.json，而不是一份抄来的预期版本字符串。注入的 TypeScript 6、vitest 4、bun 1.3.x、bun 1.4.0、React 18、Vite 6，以及产品 UI 中被禁止的 Tailwind / daisyUI / htmx / `@apply` 仍然失败。

产品 UI 不采用 daisyUI、Tailwind 或 htmx；下限拒绝它们。TypeScript 7.1-dev、bun canary 与 axe canary 不进入该钉住版本。

## Alternatives considered

**保留两份独立下限表并在文档里说明分歧。** 否决：有文档的分歧正是 vitest 4.1.11 能与 vitest 5 并存的原因。一致必须是会失败的测试，而不是一条注释。

**只比较 major。** 否决：bun 1.3 对 1.4、Vite 8.1 对 8.2，正是这些下限要抓住的漂移。

**使用 `>=` 的 bun 钉住（`bun@>=1.4.2`）。** 否决：CI 通过 `bun-version-file: package.json` 安装 `packageManager` 的精确拼写。区间会宣称尚未在该镜像上证明过的运行时。

## Consequences

提高 vitest、bun、TypeScript、React 或 Vite，意味着改 `live-stack-floors.ts` 里的 SemVer 三元组（bun 还要改根目录 `packageManager` 字段）。第二份滞后的副本会让 `collectorFloorDisagreements` 或 `packageManagerMisses` 失败。bun 包管理器决策仍由 [bun 钉住 Agent Note](2026-08-29-bun-package-manager.zh.md) 持有；本笔记持有收集器之间的一致。
