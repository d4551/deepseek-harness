# Agent Note: apps/web 的程序归属由文件名决定

Status: implemented

[English](2026-09-03-web-program-membership-by-filename.md) | 中文

## 问题

`apps/web` 横跨两个 TypeScript 检查单元。它的浏览器 e2e lane 会启动 host spine 并读取 Host 服务（`ctx.connection`、Host 侧 `SessionStore`、`ctx.sessionProjectionCache`），因此这些文件属于 `tsconfig.host.json`；而浏览器应用本身、以及在进程内挂载 Client shell 的文件属于 Client aggregate 下的 `apps/web/tsconfig.json`。两个 face 在相同的键上以不同服务对 cordis `Context` 接口做声明合并，因此单个程序无法同时持有两侧。这个切分是真实存在的，予以保留。

原有机制是两份手工维护的镜像清单。`apps/web/tsconfig.json` 按文件名排除 85 个 host 面测试文件，`tsconfig.host.json` 为 `apps/web/` 纳入与之对应的 87 个文件名。没有任何东西比对这两份清单。漏掉 Client 侧的排除会产生一次响亮的 89 条错误的构建失败；漏掉 Host 侧的纳入则产生一个静默未被检查的文件，而没有任何 gate 会发现它。已经有两个文件处于错误状态：`tests/support.ts` 同时属于两个程序，而 `vite.config.ts` 不属于任何程序——它从未被类型检查过，并藏着 `npmPackageOf` 中三个真实的 strict 模式错误。

## 决策

归属由文件名决定，采用仓库其余部分早已使用的标记。带 `.client.` 中缀的文件属于 Client 程序；`apps/web` 下其余每个 TypeScript 文件属于 Host 程序。

`tsconfig.host.json` 纳入 `apps/web/*.ts`、`apps/web/tests/**/*.ts` 与 `apps/web/stress-tests/**/*.ts`，并在原有的 `packages/*/*/tests/**/*.client.*` 各 glob 旁排除 `apps/web/tests/**/*.client.*`。`apps/web/tsconfig.json` 纳入 `src` 与 `tests/**/*.client.*`，完全不再带 `exclude`。十个文件获得该中缀：`assembled-boot.client.ts` 以及通过它挂载真实 shell 的九个 `*.client.expected.e2e.ts` 与 `*.client.e2e.ts` 场景。这十个正是 import 了 `@deepseek-ai/dsh-client-*` 包的文件，与该 tests README 早已记录为「不得 import Client 包」规则之长期例外的集合完全一致。

四个此前漂移进 Client 工程的文件不 import 任何与平面相关的东西——`support.ts`、`smoke-real.e2e.ts`、`pwa-manifest.e2e.ts` 与 `vite-entry.e2e.ts` 只持有 `node:*`、`playwright`、`execa` 与 `ws`——因此它们不带中缀，与该 lane 的其余部分一同在 Host 程序中做类型检查。`support.ts` 确实与平面无关，并非潜在缺陷；它唯一的 Client 侧消费方是 `smoke-real.e2e.ts`，后者与它一同迁移，因此再没有任何东西需要它同时存在于两个程序中。

`vite.config.ts` 通过 `apps/web/*.ts` 加入 Host aggregate。它配置浏览器 bundle，但属于不 import cordis 的 Node 构建工具，而它 import 的两个脚本本来就是 Host 根文件。它不能加入 `apps/web/tsconfig.json`：该工程设置了 `rootDir: "."`，因此来自 `scripts/` 的输入无法映射进 `outDir: lib/types`，tsc 会把编译出的 `.js` 与 `.d.ts` 写在源文件旁边，而 Vite 会优先解析它们而不是正在编辑的 `.ts`。

[`scripts/web-program-partition.ts`](../../../../scripts/web-program-partition.ts) 让该不变式可执行。它展开每个 aggregate 及其 Project References 可达的每个工程，把解析出的根文件与 `apps/web` 求交，并报告该目录下任何没有程序检查、或被两个程序同时检查的已编写 `.ts` 或 `.tsx` 文件。它在 `bun run constraints` 内运行，因此 `bun run hygiene` 与 CI 都会承载它。该检查限定在 `apps/web`，因为 `host/webserver`、`compaction/compaction` 与 `typert/registry` 是两个 aggregate 都会做类型检查的、有意为之的共享叶子工程；`apps/web` 下没有任何文件具备这种身份。

## 考虑过的替代方案

**按目录切分——`tests/host/` 与 `tests/client/`。** 这是最初的设计，读起来也不错，但它要移动 85 个文件而不是重命名 10 个，且代价落在 fixture 上。golden 通过写死在每个测试内部的字面路径 `apps/web/tests/expected/<case>/...` 解析，`*.overlay.yml` 靠同名兄弟文件与其测试配对，而 `tests/expected/` 混合了两个平面的用例，因此目录切分还必须移动或分叉整棵 fixture 树。它还会为一个仓库已经在 `packages/*/*/tests` 中以单一方式表达的概念再发明第二套机制。

**在现有文件名上使用后缀规则。** 无法表达：`pwa-manifest.e2e.ts` 与 `vite-entry.e2e.ts` 属于一个平面，而 `agent-team-panel.e2e.ts` 属于另一个，三者扩展名相同。给少数派加上一个新中缀，才使 glob 成为可能。

**保留枚举，只加 gate。** 单独的 gate 把静默失败转成响亮失败，这已是大部分价值，但它留下两份需要维护的清单，且每个新测试文件仍要在两份配置中做方向相反的编辑。gate 让这类缺陷不可能发生；中缀让它不再出现。

**把 `support.ts` 标为 `.client.` 以便 glob 成立。** 那会把一个与平面无关的文件留在 Client 程序中，并迫使它的 81 个 Host 消费方跨切分 import。把它与其唯一的 Client 消费方一并归入 Host 程序，才是这次双重归属真正需要的解法。

**把 host 侧四条 `packages/*/*/tests/**/*.client.{ts,tsx,spec.ts,spec.tsx}` 排除合并为一条 `*.client.*` glob。** 在当前代码树上行为完全一致且少三行，但它扩大了本次变更并未触及的规则。推迟。

**把 `scripts/client-bundle-css.spec.ts` 与 `scripts/client-bundle-purity.spec.ts` 重命名以匹配 `scripts/*.client.spec.ts`。** 并非机械改动：`scripts/oxlint-contract.spec.ts` 断言了 purity spec 的路径，且一篇 implemented Agent Note 把它记为固定 client-bundle 条目的 gate。推迟。

## 后果

给这个 lane 增加测试不再需要编辑任何 tsconfig。两份配置描述规则而不是罗列成员，且两份清单不可能漂移，因为已经没有清单。`tsconfig.host.json` 减少 87 行、增加 3 行；`apps/web/tsconfig.json` 减少 85 行。

把 `vite.config.ts` 纳入程序暴露了 `npmPackageOf` 中三个 `noUncheckedIndexedAccess` 错误，它现在通过 `lastIndexOf('/node_modules/')` 推导包名段，并对 split 结果做显式的 `undefined` 检查。行为不变。

十次重命名改变了收集 glob 的输入但没有改变其结果：每个被重命名的文件都保留 `.e2e.ts` 后缀，因此 `vitest.web.config.ts` 仍然收集它。web lane 变更前后都收集 94 个文件，与此前的 93 之差仅来自另一个分支在本次变更期间落地的一个测试。

## 测试

`scripts/web-program-partition.spec.ts` 构造处于三种状态的仓库 fixture 并全部固定：完整切分通过；把 `vite.config.ts` 从所有 include 中移除会报告该未被检查的文件；把 `.client.` 排除从 Host 程序中移除会报告该被双重检查的文件。在本次变更之前的代码树上，同一个 gate 报告了 `tests/support.ts` 同属两个程序、`vite.config.ts` 不属于任何程序，两个缺陷正是这样被发现的。

## 相关

[两 aggregate 的解决方案根](../process/2026-07-22-tsconfig-solution-root-two-aggregates.zh.md)是两个程序为何存在的归属文档。[浏览器 e2e lane note](../testing/2026-07-24-web-gui-browser-e2e-lane.zh.md)是该 lane 本身的归属文档，而[`apps/web/tests/README.zh.md`](../../../../apps/web/tests/README.zh.md)在作者遇到它的地方陈述该中缀规则。
