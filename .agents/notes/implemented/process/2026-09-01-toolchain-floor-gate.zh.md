# Agent Note: CI 所依赖版本下限的门禁

Status: implemented

[English](2026-09-01-toolchain-floor-gate.md) | 中文

## 问题

版本漂移审计发现，仅有的真实降级防护是 `bun.lock`（可再生）与 CI 矩阵分支：`checkSingleExternalVersion` 只约束"各 manifest 中同一依赖的基础版本一致"，对*是哪个版本*只字未提；也没有任何测试钉住 engines 字符串、packageManager 值或任何工具链下限。一次协同降级——`typescript@^6`、`vite@^7`、`react@~18`——能通过当时所有门禁。

## 决策

`scripts/verify-toolchain-floors.ts`（含 spec）按版本下限断言工具链钉住值：

- `engines.node` 必须逐字等于 `^22.19.0 || >=24.0.0`，`packageManager` 必须精确等于 `bun@1.4.0`。
- 工具链依赖必须不低于 `(major, minor)` 下限，检查覆盖根 manifest 与 `apps/web/package.json`（浏览器工具链——react、playwright——钉在 web 入口而非根）：typescript `7.0`、vite `8.2`、react/react-dom `19.2`、playwright `1.62`、vitest `4.1`、tsx `4.23`。
- 某工具链名在所有 manifest 中消失本身就是 finding——把依赖处处移除等于对 CI 实际运行内容的静默降级。
- `rangeMeetsFloor` 读取范围的基础版本（`^`、`~`、`>=` 或裸版本）：major 或 minor 低于下限即失败；更高 major 的基础版本放行，因为未测试的更新工具链不是下限违规，而由实际使用它的分支负责暴露。

注册为 `ciSharedStaticGates`（`scripts/run-gates.ts`）中的 `toolchain-floors` 叶子，因此运行于 `ci-primary`、`ci-static` 及共享这些门禁的每个聚合。包脚本：`bun run verify-toolchain-floors`。

## 备选方案

**只依赖 Renovate/lockfile 漂移检测。** 这些工具负责更新，不负责禁止。人类合并一次有意的降级时，仍需要一道能点名下限的门禁；而 lockfile 可在降级所在的同一 PR 里再生。

**在根 manifest 里钉精确版本。** caret 范围是有意的——patch 与 minor 变化受信任。下限保留范围语法的同时，让跌破已测工具链的基础版本失败。

**只检查根 manifest。** 浏览器工具链（react、playwright）钉在 `apps/web` 而非根；只扫根会恰好漏掉降级会破坏的那批分支。

## 后果

七条工具链、engines 字符串或 bun 钉住值的协同降级如今会令 `ci-static` 失败。代价是每次有意抬高下限都要改一次门禁——而这处修改正是"声明 CI 现在假定哪个工具链版本"的可评审动作。首次实跑暴露了一棵脏树（`packages/util/diagnostic-text/lib/index.js` 缺失，令根 tsdown 配置死锁），通过把 tsc 产出的 `lib/types/{index,invariant}.js` 拷入 `lib/` 引导解决；`bun run build:lib:host` 自己会再生这些文件。
