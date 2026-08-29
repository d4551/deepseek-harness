# Agent Note: 手动将同主版本注册表依赖对齐到最新，并排除主版本升级与 vendor

Status: implemented

[English](2026-08-30-manual-same-major-dependency-bump.md) | 中文

## 问题

已声明的注册表固定版本落后于同主版本的最新发布，且两个文件监视器仍依赖 chokidar 4，而 `skill-filesystem` 与 `webworker-runtime` 已经依赖 chokidar 5。Dependabot 按每周冷却期提出达到隔离时长的更新，并不覆盖这类经评审的手动对齐。一次性 `bun update --latest` 还会带上需要单独迁移的主版本。

## 决策

工作区为本次更新的包保持同主版本最新固定值，主版本升级、随源码纳入的包以及已打补丁的包继续使用它们现有的版本。

同主版本固定值：

| 包 | 固定值 |
|---|---|
| `knip` | `^6.33.0` |
| `oxlint` | `1.80.0` |
| `mermaid` | `11.17.2`（根目录与 website） |
| `@yarnpkg/cli-dist` | `4.18.0` |
| `ws` | `8.21.3`（原先使用精确版本的保持精确版本，原先使用插入符的保持 `^8.21.3`） |
| `cytoscape` | `3.34.2` |
| `dayjs` | `1.11.23` |
| `use-sync-external-store` | `1.6.0` |
| `chokidar` | `credentials-local` 与 `settings-file` 中为 `^5.0.0` |

`credentials-local` 与 `settings-file` 继续使用具名 `watch` 导出、`ignoreInitial`、`awaitWriteFinish` 以及 `watcher.close()`。vendor 中的 `hmr` 仍使用 chokidar `^4.0.3`，因为随源码纳入的 manifest 只能通过 [vendor/README.md](../../../../vendor/README.md) 变更。

以下主版本在单独迁移完成前保持现有主版本：React 19、`@types/react` 19、`@vitejs/plugin-react` 6、`apps/web` 与 VitePress 站点的 Vite 8、js-yaml 5、jsdom 30、immer 11、zustand 5、katex 0.18、eventsource-parser 4、`typescript-language-server` 6、根目录的 `@types/node` 26（引擎下限仍是 Node 22）、`@types/picomatch` 4、e2b 2.46、OpenTelemetry 0.221，以及 Anthropic/Codex 的 0.x 跳跃。`node-pty` 与 `@stryker-mutator/core` 继续使用已打补丁的版本。Zod 保持 4.4.3，直到 `minimumReleaseAge` 允许更新的 4.x 通过。

[Dependabot 30 天冷却期决策](2026-07-27-dependabot-version-updates.zh.md) 下仍允许手动更新；该冷却期适用于自动化每周路径，不适用于经明确评审的固定值调整。

## 曾考虑的替代方案

**对每个工作区执行 `bun update --latest`。** 否决：这会在一次锁文件重写中带上 React 19、js-yaml 5、VitePress 上的 Vite 8 以及其他主版本，并改写随源码纳入的 manifest。

**让两个监视器继续使用 chokidar 4。** 否决：仓库已在 `skill-filesystem` 与 `webworker-runtime` 中运行 chokidar 5；为同一监视 API 保留两个主版本是意外漂移，不是已记录的拆分。

**在本次把 e2b、OpenTelemetry 以及 Anthropic/Codex 的 0.x 包一并升级。** 否决：这些 SDK 会改动调用点与提供方契约，需要它们自己的测试，而不是一次固定值重写。

## 后果

Oxlint 1.80 可能发出 1.76 固定值不会发出的诊断。Knip 6.33 可能发出新的配置提示；`knip --treat-config-hints-as-errors` 仍会因此让 hygiene 通道失败。之后的主版本升级仍需要自己的 Agent Note 和测试，而不能依附这组固定值。
