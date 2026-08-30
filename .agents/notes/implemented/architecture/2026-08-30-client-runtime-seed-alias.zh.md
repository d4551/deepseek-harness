# Agent Note: 为树外 bundle 播种历史 client-runtime 键

Status: implemented

[English](2026-08-30-client-runtime-seed-alias.md) | 中文

## 问题

已经构建好的树外客户端 bundle（例如 `dsh-context-doctor`）会调用 `require("@deepseek-ai/dsh-client-runtime/client")` 来取得 `defineStore`。外壳从未播种该 specifier。`defineStore` 位于 `@deepseek-ai/dsh-client-store`，因此 factory 会抛出模块表未命中，启动页报告插件失败。

## 决策

`getStaticModules` 用与 `@deepseek-ai/dsh-client-store` 相同的单例回答 `@deepseek-ai/dsh-client-runtime` 与 `@deepseek-ai/dsh-client-runtime/client`。这两个键不是 `PLATFORM_MODULES` 词条，因此第一方 tsdown 不会把它们当作基座 external，也仍然不存在 `dsh.client.provide` 别名协议。新的第一方代码与重新构建的树外代码导入 `@deepseek-ai/dsh-client-store`。

## 考虑过的替代方案

**把历史 specifier 加入 `PLATFORM_MODULES`。** 否决：这会为一个并非工作区包的名字扩大第一方 external 基座，正是模块图规则拒绝的 `dsh.client.provide` 别名。

**重建或修补每一个已安装的树外 bundle。** 对这些插件的新版本仍然正确，并且当它们导入 store 单例未导出的 API 时仍然必须这么做。它无法解开只需 `defineStore` 的既有产物。

## 后果

若某个历史 bundle 从 `dsh-client-runtime` 要求的是别的导出，仍会大声失败。这次播种变更之后必须重建 `apps/web`，因为 `dsh web` 提供的是 Vite `dist/`。
