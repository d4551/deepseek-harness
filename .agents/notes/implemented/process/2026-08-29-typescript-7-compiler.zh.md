# Agent Note: 用 TypeScript 7 编译，compiler API 消费方继续使用 6.0 API

Status: implemented

[English](2026-08-29-typescript-7-compiler.md) | 中文

## 问题

TypeScript 7.0 提供基于 Go 的 `tsc`，但不提供稳定的 programmatic API；该 API 在 7.1 落地。本仓库通过 `tsc` 编译，并且 Typert generator 与各 gate 脚本也会导入 compiler API。在 6.x 中同时承担编译与 API 的同一个 `typescript` 主版本，现在无法同时承担这两项工作。

## 决策

使用 TypeScript 7.0.2（`typescript` ^7.0.2）编译 Host 与 Client program。compiler API 消费方导入 `@typescript/typescript6`，它再导出 6.0 API，并提供 `tsc6`，因此不会与 `tsc` 撞名。`typert/generator` 声明它实际导入的包。

TypeScript 7 拒绝 6.0 曾接受的两种写法。同一个名字不能既承载导入的类型含义，又承载本地声明的值含义；`cordis-host-runner` 把工厂函数放在 `types.ts` 里，与类型别名放在一起。`@ts-expect-error` 必须写在 TypeScript 7 报告错误的那一行，而不能写在多行调用的前一行。

根 README 把这一编译固定版本写进本检出的工具链。贡献者搭建步骤见[开发指南](../../../../docs/development.zh.md)。包管理器固定版本是 [bun 包管理器 Agent Note](2026-08-29-bun-package-manager.zh.md) 中的另一项决策。

## 考虑过的替代方案

**编译与 API 都留在 TypeScript 6.0.3。** 否决：本检出采用的编译固定版本是 Go 版 `tsc`，而兼容包正是为这段 API 窗口提供的。

**compiler API 也导入 `typescript` 7。** 否决：7.0 没有稳定的 programmatic API。31 个 API 导入方（其中 25 个是 gate 脚本）会因此损坏。

**等到 TypeScript 7.1，再用同一个包承担两项工作。** 否决：编译固定版本现在即可使用。日后将 API 升到 7.1 与当前 `tsc` 固定版本相互独立。

## 结果

`bun run typecheck` 与 `bun run build` 运行 Go 编译器。依赖 API 的 gate 与 Typert 继续使用 6.0 API，直到 7.1 提供稳定替代。升级 `@typescript/typescript6` 与升级 `typescript` 相互独立。
