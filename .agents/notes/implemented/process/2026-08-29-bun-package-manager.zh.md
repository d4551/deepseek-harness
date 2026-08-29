# Agent Note: bun as the package manager instead of pnpm

Status: implemented

[English](2026-08-29-bun-package-manager.md) | 中文

## Problem

仓库此前通过 **pnpm 11.7.0** 安装依赖并运行脚本（见 [pnpm 决策](2026-06-16-pnpm-over-yarn.zh.md)），它带来了严格的符号链接式 `node_modules`：其 phantom dependency（幽灵依赖）失败对整套 gate 而言是承重的。pnpm 在 Node 之外额外引入一条工具链——Corepack 供给、store 守护进程、只有 pnpm 能读的 lockfile——而这些工作本质上只是安装与运行。bun 把它们收拢进一个同时能运行 TypeScript 的二进制文件，且其 isolated linker 复现了正确性论证所依赖的非扁平布局。包管理器仍然只需解析并链接 `node_modules`、运行 workspace 脚本、满足 workspace 约束，因此影响面被限定在安装、脚本再入与 CI 供给三处。

## Decision

采用 **bun 1.3.11**，通过 `packageManager` 字段固定；CI 使用 `oven-sh/setup-bun` 并以 `bun-version-file: package.json` 安装该固定版本。产品运行时仍是 Node：`engines.node` 与所有出货启动器保持不变，因为单文件可执行构建、`node-pty` 与 SEA 载体都是 Node 产物。

- **Workspaces** 从 `pnpm-workspace.yaml` 迁回 `package.json` 的 `workspaces` 数组（bun 原生读取该字段）；`python/sdk-runtime` 加入其中已列出的 glob。`pnpm-workspace.yaml` 被删除，`pnpm-lock.yaml` 变为 `bun.lock`。
- **`bunfig.toml` 承载安装策略。** `linker = "isolated"` 保持非扁平布局，因此未声明的传递性导入仍在解析时失败，而不是借用兄弟包的依赖树。`minimumReleaseAge = 86400` 重述 pnpm 11 默认施加的供应链等待期，`minimumReleaseAgeExcludes` 承载 pnpm 配置中已审阅的豁免项，并新增 `@earendil-works/pi-telemetry`——pi-ai 家族按同一版本序列发布，只豁免其中一半会导致解析死锁。
- **`trustedDependencies` 取代 `allowBuilds`** 作为安装脚本白名单，`patchedDependencies` 从 workspace 文件迁入 `package.json`；`node-pty` 补丁原样生效。
- **无 shell 的包管理器再入被简化。** bun 始终在 `npm_execpath` 中报告自身二进制，因此 `scripts/bun-invocation.ts` 直接 spawn 该入口，并去掉了 pnpm 的 JavaScript 入口分支。Gate 再入写作 `bun run <script>` 与 `bun x <binary>`。
- **Python 运行时闭包改为安装而非 deploy。** bun 没有 `deploy` 动词，因此 `scripts/build-exe-for-python-sdk.ts` 把 deploy 根的 manifest（元数据清单）写入暂存目录，并将每个 `workspace:` 区间改写为绝对 `file:` 路径，随后在该目录运行 `bun install --production --linker=hoisted`。既有的链接实体化步骤保持不变，因为它本就负责把 deploy 期的链接替换为文件。
- **测试运行器被固定到实现了 `import.meta.resolve` 的 vite 上。** vitest 声明 `vite` 为 `^6 || ^7 || ^8`，而 bun 用依赖图中已存在的最低版本满足它——即 `apps/web` 固定的 6.4.3——pnpm 则安装 8.x。vite 5 与 6 的 module runner 拒绝 `import.meta.resolve`，而产品源码用它按 `import` 导出条件解析。根级 `vite` devDependency 加上作用域化的 `overrides.vitest.vite` 恢复了该配对；该 override 只在解析结果中已存在 vite 8 时才生效，因此两者缺一不可。
- CI、GitLab CI、lefthook、包脚本与文档中的所有 `pnpm …` 动词改写为 bun 拼法。`.gitignore` 将 `.pnpm-store/` 换成 bun 的对应项。按 Vendoring Policy，vendored README 保留其上游示例不动。

## Runner isolation

`pnpm/action-setup` 接受按 job 区分的 `dest`，CI 工作流据此确保自托管 runner 上的并发 job 永不争抢同一份 pnpm 安装（见 [runner 隔离 Agent Note](../bug-fix/2026-07-29-pnpm-setup-runner-isolation.zh.md)）。`oven-sh/setup-bun` 无条件安装到 `~/.bun/bin` 且不暴露等价入参，因此该隔离确实不可用。替代不变式是每个 `setup-bun` 步骤都解析出**同一个**版本：`scripts/ci-workflow.spec.ts` 断言每一处都传入 `bun-version-file: package.json` 且没有浮动的 `bun-version`，于是并发 job 安装的是完全相同的字节，而不是相互竞争的不同版本。

## Alternatives considered

**继续使用 pnpm。** 零改动，并保留按 job 的 runner 隔离。但它也保留了第二条工具链，其供给、store 与 lockfile 的存在只为安装单个二进制文件就能安装的包。

**使用 bun 的 hoisted linker。** 迁移更平滑——没有按包的 `node_modules` 树、解析意外更少——但会丢弃 phantom dependency 安全性，而那正是布局保持严格的主要正确性理由。hoisted linker 只在两处确实需要扁平树的地方保留：Wine gate 的快照安装与 Python 运行时闭包。

**把 `import.meta.resolve` 调用点改写为 `createRequire`。** 这能让测试套件在 vite 6 下通过且不触碰解析配置，但 `require.resolve` 选择的是 `require` 导出条件。解析 `tsx/esm`、`tsx/esm/api` 或仅 ESM 入口的站点会静默解析到不同文件，等于把一次响亮的失败换成产品源码中的一次静默失败。

**把 vitest 固定到 4.1.8。** 那只是最先跑通的版本。它并非真正的变量——4.1.11 与 vite 8 配对后同样通过——因此固定它会记录一个错误的成因，并把真正的成因潜伏在 caret 区间之后。

**全局 `overrides.vite`。** 比作用域化 override 更简单，但站点的 VitePress 工具链需要 vite 5，而 `apps/web` 的 React 插件上限是 vite 7；单一全局版本无法同时满足运行器与这两者。

## Consequences

安装与脚本再入现在只需要一个同时能运行 TypeScript 的二进制文件，且 lockfile 是可在评审中阅读的文本格式。`verify-vendored-links` 通过 `jsonc-parser` 结构化读取 `bun.lock`——bun 写出的是 JSONC——并且现在还会在某个 vendored 名称完全不出现在 `packages` 中时失败，这是 pnpm 时代的 importer 扫描看不见的情形。

代价是具体的。按 job 的 runner 隔离已经消失，取而代之的是版本固定不变式，而后者更弱：两个 job 仍然写同一路径，只是写入相同字节。与 pnpm 的解析差异并非都能靠阅读 manifest（元数据清单）发现——vite 配对问题只以 138 个失败测试的形式浮现——因此未来一次依赖升级可能以同样方式静默地重新去重某个 peer。Python 单文件可执行路径与 Wine Windows gate 已完成转换，但在本次迁移中未被端到端执行；两者都需要首次真实 CI 运行来确认。
