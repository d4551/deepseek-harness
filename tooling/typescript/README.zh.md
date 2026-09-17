---
description: "重建 TypeScript 属性签名声明并验证安装后的编译器 API。"
---

# TypeScript AST 声明

[English](README.md) | 中文

## Summary

验证没有类型标注的 TypeScript 属性，同时保留缺失值检查。维护的编译器声明描述缺失的类型标注和初始化器，生成器拒绝必须具有显式类型却没有标注的条目。

## Table of Contents

- [重建](#reconstruction)
- [安装验证](#installed-verification)
- [源码归属](#source-ownership)
- [Dev Note](#dev-note)

## Reconstruction

使用 [provenance.json](provenance.json) 中记录的 Node 和 Bun 版本、Git，以及访问记录的官方归档和 npm 包所需的网络。从仓库根目录运行：

```sh
bun tooling/typescript/rebuild.mjs check
```

该命令将通过完整性检查的编译器源码及发布包下载到新目录，安装冻结的[构建依赖](build/bun.lock)，应用 [AST 模式修正](schema.patch)，运行上游生成器，并严格编译完整的 JavaScript API。它将完整的输出文件集合与发布的 API 比较，并要求每个可执行 JavaScript 文件保持逐字节一致。产物检查会将生成的补丁及全部文件摘要与记录的产物比较。命令会输出保留的重建目录；审查结果后可删除该目录。

修改模式补丁或构建输入后，生成产物并独立检查：

```sh
bun tooling/typescript/rebuild.mjs rebuild
bun tooling/typescript/rebuild.mjs check
```

一并审查模式、构建输入、生成的声明、源码映射和[完整 API 清单](artifacts/inventory.json)。生成产物必须来自重建过程。

## Installed verification

根包清单安装生成的[包补丁](artifacts/typescript@7.0.2.patch)。运行常规的已安装分发测试：

```sh
bun x vitest run scripts/typescript-ast-contract.spec.ts
```

这些测试将每个已安装 API 文件与记录的摘要比较，验证生成器解析到相同的编译器包，编译缺失值契约，执行真实 AST 工厂，并解析有标注及无标注的属性。生成器和目录测试套件负责验证各自的消费方；分发检查不证明仓库覆盖率或变异测试验收达标。

## Source ownership

官方编译器提交和归档完整性记录在 [provenance.json](provenance.json) 中。[模式修正](schema.patch)在 `_scripts/ast.json` 中将 `PropertySignatureDeclaration.type` 和 `initializer` 都标记为可选。上游生成器根据该模式生成接口和工厂参数。原生编译器和 JavaScript 执行保持发布版实现。[生成器决策记录](../../.agents/notes/implemented/bug-fix/2026-08-31-typert-generator-typescript-7-repairs.zh.md)负责消费方验证要求。

编译器保留 Apache-2.0 许可证，并在[第三方声明](../../THIRD_PARTY_NOTICES.md)中披露。

## Dev Note

无。
