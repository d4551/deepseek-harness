# Agent Note：Typert 入口面校验接受所有 Node 合法的 exports 形态

Status: implemented

[English](2026-08-30-typert-entry-surface-node-legal-exports.md) | 中文

## 问题

`validatePackageEntrySurface` 此前拒绝两类合法包。`package.json` 未声明 `exports` 字段的包，只有在同时声明 `types` 时才被接纳，尽管分析器本可以直接从包源码发现源导出。超出子路径映射的 Node 合法 `exports` 形态——裸字符串、条件对象、回退数组——也被判为畸形，导致真实世界的清单在任何类型图构建之前就中止分析。

## 决策

入口面校验现在与 Node 自身的 `exports` 语法保持一致。没有 `exports` 的包按原样接纳，其源导出直接发现。存在的 `exports` 字段可以是字符串、条件对象、子路径映射或回退数组；仅当字段为 `null` 或既非对象也非字符串时才抛出。目标存在性与包根包含检查仍适用于每个携带源的条目，生成产物与数据条目（`./typert`、`.json`、`.yml`、通配符）仍豁免目标检查。

## 已考虑的替代方案

**保留对无 exports 包的 `types` 要求。** 已拒绝：源发现已覆盖这些包，该要求只会拒绝合法清单，而不提供分析器会使用的信息。

**将字符串与数组 `exports` 判为不支持。** 已拒绝：两者均为 Node 合法形态且出现在已发布包中；拒绝它们使分析器无法用于真实依赖树。

## 后果

分析器接纳此前会中止的清单，夹具套件覆盖字符串、条件对象、子路径映射与无 exports 包。同一变更中的测试更新也吸收了 TypeScript 7 的行为差异：畸形 `tsconfig` 不再中止发现，且项目引用发现在夹具钉住的边缘情形上与 TypeScript 6 不同。
