# Agent Note: 用 TypeScript 7 编译；Strada compiler API 导入仍是残留

Status: implemented

[English](2026-08-29-typescript-7-compiler.md) | 中文

## 问题

TypeScript 7.0 提供基于 Go 的 `tsc`。`typescript` 包的默认导出是版本元数据（`lib/version.cjs`），不是 6.0 Strada compiler API（`createProgram`、`createSourceFile`、`ts.sys`）。Microsoft 把*稳定*替代写在 7.1。本仓库通过 `tsc` 编译，并且 Typert 与各 gate 脚本也会遍历 program 和源文件。

## 决策

使用 TypeScript 7.0.2（`typescript` ^7.0.2）编译 Host 与 Client program。该包已经在 `typescript/unstable/sync`（Snapshot / Project / Program / Checker）和 `typescript/unstable/ast`（`SyntaxKind`、visitor、factory）导出新的 compiler API。`scripts/typescript7-unstable-api.spec.ts` 从这一强制固定版本加载这些导出，并用 `API.parseConfigFile` 解析 `tsconfig.host.json`。

gate 脚本和 Typert 仍导入 `@typescript/typescript6`，即 6.0 Strada API 加上 `tsc6`。那是 TypeScript 7 编译固定版本上的 TypeScript 6 残留，不是第二套编译工具链。替换这些导入是改写到 `typescript/unstable/*`，不是改 import 名：6.0 的 `createProgram` 面不在 `import 'typescript'` 上。

TypeScript 7 拒绝 6.0 曾接受的两种写法。同一个名字不能既承载导入的类型含义，又承载本地声明的值含义；`cordis-host-runner` 把工厂函数放在 `types.ts` 里，与类型别名放在一起。`@ts-expect-error` 必须写在 TypeScript 7 报告错误的那一行，而不能写在多行调用的前一行。

根 README 把这一编译固定版本写进本检出的工具链。贡献者搭建步骤见[开发指南](../../../../docs/development.zh.md)。包管理器固定版本是 [bun 包管理器 Agent Note](2026-08-29-bun-package-manager.zh.md) 中的另一项决策。

## 考虑过的替代方案

**编译与 API 都留在 TypeScript 6.0.3。** 否决：本检出采用的编译固定版本是 Go 版 `tsc`，而兼容包正是为这段 API 窗口提供的。

**为 `createProgram` 导入 `typescript` 7 的默认导出。** 否决：该导出是版本元数据。6.0 Strada 方法不在那里。

**把 `@typescript/typescript6` 当作已经完成的 TypeScript 7 转换。** 否决：该包是 TypeScript 6.0。TypeScript 7 是编译强制要求；剩余的 Strada 导入是尚未完成的、改写到 `typescript/unstable/*` 的转换。

**等到稳定的 TypeScript 7.1 API 标签才使用任何 7 API。** 否决作为存在性检查：7.0.2 已经提供 `typescript/unstable/*`。日后的 7.1 稳定标签可以去掉 `unstable/` 路径，而不必改编译固定版本。

## 结果

`bun run typecheck` 与 `bun run build` 运行 Go 版 `tsc`。仍有 31 个文件导入 `@typescript/typescript6`。在改写到 `typescript/unstable/sync` 与 `typescript/unstable/ast` 之前，它们继续对着 6.0 API 工作。升级 `@typescript/typescript6` 与升级 `typescript` 相互独立。
