# Agent Note: 用 TypeScript 7 编译；所有 compiler API 导入均为 TS7 原生

Status: implemented

[English](2026-08-29-typescript-7-compiler.md) | 中文

## 问题

TypeScript 7.0 提供基于 Go 的 `tsc`。`typescript` 包的默认导出是版本元数据（`lib/version.cjs`），不是 6.0 Strada compiler API（`createProgram`、`createSourceFile`、`ts.sys`）。Microsoft 把*稳定*替代写在 7.1。本仓库通过 `tsc` 编译，并且 Typert 与各 gate 脚本也会遍历 program 和源文件。

## 决策

使用 TypeScript 7.0.2（`typescript` ^7.0.2）编译 Host 与 Client program。该包已经在 `typescript/unstable/sync`（Snapshot / Project / Program / Checker）和 `typescript/unstable/ast`（`SyntaxKind`、visitor、factory）导出新的 compiler API。`scripts/typescript7-unstable-api.spec.ts` 从这一强制固定版本加载这些导出，并用 `API.parseConfigFile` 解析 `tsconfig.host.json`。

所有 compiler-API 使用方——Typert、各 gate 脚本，以及通过 `jsonc-parser` 解析 JSONC 的 Stryker tsconfig 补丁——都使用 `typescript/unstable/*`；依赖图中不存在 `@typescript/typescript6` 兼容包，且任何 manifest 或源码重新导入它时 `scripts/typescript7-unstable-api.spec.ts` 会失败。脱离 6.0 API 的改写不是改 import 名：6.0 的 `createProgram` 面不在 `import 'typescript'` 上，因此隔离解析、按配置打开 project 与打印都迁移到由 `ts7-session.ts` 持有的 `API`/`Project`/`Emitter` 会话。

TypeScript 7 拒绝 6.0 曾接受的两种写法。同一个名字不能既承载导入的类型含义，又承载本地声明的值含义；`cordis-host-runner` 把工厂函数放在 `types.ts` 里，与类型别名放在一起。`@ts-expect-error` 必须写在 TypeScript 7 报告错误的那一行，而不能写在多行调用的前一行。

根 README 把这一编译固定版本写进本检出的工具链。贡献者搭建步骤见[开发指南](../../../../docs/development.zh.md)。包管理器固定版本是 [bun 包管理器 Agent Note](2026-08-29-bun-package-manager.zh.md) 中的另一项决策。

## 考虑过的替代方案

**编译与 API 都留在 TypeScript 6.0.3。** 否决：本检出采用的编译固定版本是 Go 版 `tsc`，而兼容包正是为这段 API 窗口提供的。

**为 `createProgram` 导入 `typescript` 7 的默认导出。** 否决：该导出是版本元数据。6.0 Strada 方法不在那里。

**把 `@typescript/typescript6` 当作已经完成的 TypeScript 7 转换。** 否决：该包是 TypeScript 6.0。TypeScript 7 是编译强制要求；剩余的 Strada 导入是尚未完成的、改写到 `typescript/unstable/*` 的转换。

**等到稳定的 TypeScript 7.1 API 标签才使用任何 7 API。** 否决作为存在性检查：7.0.2 已经提供 `typescript/unstable/*`。日后的 7.1 稳定标签可以去掉 `unstable/` 路径，而不必改编译固定版本。

## 结果

`bun run typecheck` 与 `bun run build` 运行 Go 版 `tsc`，整个仓库的编译与分析都通过 TypeScript 7 API 完成，不安装任何 TypeScript 6 包。`eslint-plugin-sonarjs` 已从 lint 工具链移除：它在模块加载时读取 6.0 compiler API（`cjs/helpers/type.js`）并硬性要求 `typescript <6.1`，在纯 TS7 依赖图下无法加载。其相同条件与重复组合成员的检测由 Oxlint 原生规则（`no-dupe-else-if`、`typescript/no-duplicate-type-constituents`）承担；其余重复形态规则在 Oxlint 原生移植之前由 jscpd 的 `bun run duplication` gate 兜底。
