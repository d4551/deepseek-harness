# Agent Note: 仅源码的 fork 启动路径

Status: implemented

[English](2026-09-01-source-only-fork-launch-path.md) | 中文

## 问题

根 README 曾把 `npx @deepseek-ai/dsh web` 作为运行本仓库的首个受支持方式。该包名位于上游 npm scope，本 fork 无法向其发布，因此该命令安装的是上游发行版，永远不是本检出——既不是它的源码，也不是它的 bun 1.4 / TypeScript 7 工具链，更不是它的本地构建客户端身份。照着「运行」章节第一条可执行命令操作的读者，运行的程序与 README 其余部分所描述的并不相同。

## 决策

README 只给出一条启动路径：克隆本 fork，然后 `bun install`、`bun run build`、`bun run dsh web`。fork 章节写明本 fork 不发布自己的软件包，且 `npx @deepseek-ai/dsh` 拉取的是上游发行版，使该 npm 命令仍可被查到，但归属为上游入口而非本仓库入口。这取代了[产品优先根 README Agent Note](2026-07-22-product-first-root-readme.zh.md) 中的 npm 启动路径；该决策的其余部分继续有效。

包身份不变。`apps/cli` 保留 `@deepseek-ai/dsh` 名称、其公开 `publishConfig`，以及打包并校验它的 release family，因为本 fork 与上游共用 scope、命名约定和 rescope 映射。改变的只是 README 不再把本 fork 无法发布的 scope 当作运行本 fork 的方式。

## 曾考虑的替代方案

**保留 npm 路径并加警告。** 不予采纳，因为「运行」章节正是新读者最先执行的内容，而写在可执行命令上方的注意事项，往往在命令已经装错构建之后才被读到。

**把已发布包改名到 fork 自有 scope。** 不予采纳，因为那会 rescope 每一个 workspace 包，违背 `@deepseek-ai/dsh-*` 命名约定与 [rescope 映射](../../../../docs/rescope.zh.md)，并使本 fork 承担它并不运营的发布通道。

**把 npm 路径指向上游仓库。** 不予采纳，因为上游 README 已经拥有自己的安装说明，而首先把读者送走的「运行」章节，不构成本检出的入口。

## 后果

两侧 README 的「运行」章节各只保留一个`### 从源码运行`子章节，因此 `#run` 与 `#run-from-source` 对 [Web UI 指南](../../../../docs/user/guide/index.zh.md)、[模型配置指南](../../../../docs/user/guide/providers.zh.md)、[插件教程](../../../../docs/user/develop/basic/index.zh.md)与[发布指南](../../../../docs/user/develop/basic/publish.zh.md)仍然可解析。描述已安装 `dsh` 二进制的文档（如 CLI 参考与插件发布指南）对持有上游软件包的读者依然适用；它们并非关于本 fork 分发方式的声明。若本 fork 日后以自有名称发布，届时会补回该路径并取代本 Note，而不是修改本 Note。
