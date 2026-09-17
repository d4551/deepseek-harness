---
description: "重建并验证所维护的 Stryker 源码发行包、依赖归属和原生进程回归检查。"
---

# 所维护的 Stryker 发行包

[English](README.md) | 中文

## 概述

从已验证的上游源码重建变异测试运行器，并在安装生成的包前检查每一处本地源码修改。本贡献者参考文档负责重建流程和包证据；仓库的变异测试阈值仍独立执行。

## 目录

- [重建与检查](#rebuild-and-check)
- [源码与依赖归属](#source-and-dependency-ownership)
- [验证限制](#verification-limits)
- [开发备注](#dev-note)

-----

<a id="rebuild-and-check"></a>

## 重建与检查

使用 [toolchain.json](provenance/toolchain.json) 中指定的准确 Bun 和 Node 版本、Git、可访问固定版本官方归档与注册表的网络，以及 Playwright 安装的 Chromium。从仓库根目录运行：

```sh
bun tooling/stryker/rebuild.mjs check
bun test tooling/stryker/src/integrity.test.mjs
node tooling/stryker/verify-installed.mjs
```

检查会在操作系统的临时目录下重建一个全新目录，安装[冻结的构建依赖图](build/bun.lock)，使用原生 TypeScript 编译完整的 instrumenter、core 和 runner 源码，并运行所维护的原生回归测试。它会拒绝归档完整性错误、命令失败、包字节变化和文件清单变化。无论成功还是失败，它都会输出保留目录的位置，其中包含完整的命令与浏览器日志。审查证据后可删除该目录。

审查可读的[源码与回归补丁](patches/)修改后，重新生成产物并独立检查：

```sh
bun tooling/stryker/rebuild.mjs rebuild
bun tooling/stryker/rebuild.mjs check
```

`rebuild` 只在编译与回归测试成功后写入产物。请一并审查源码补丁、构建 manifest（元数据清单）与锁文件、生成的 instrumenter 和 runner 补丁、完整的[包内文件清单](artifacts/inventory.json)和[产物哈希](artifacts/hashes.json)。不要手工编辑生成的 JavaScript、声明、源码映射或 tarball。

生成的补丁保留两行上下文，空上下文行不带前导空格。生成过程使用 Git 的原生检查拒绝空白错误。完整性测试会应用生成的补丁，并比较所得源码的字节。

-----

<a id="source-and-dependency-ownership"></a>

## 源码与依赖归属

[upstream.json](provenance/upstream.json) 记录官方 NPM 归档的完整性信息、源码提交、源码归档摘要及准确的额外构建输入。重建过程保留已发布的 API 包，删除已发布的 instrumenter、core 和 runner 输出，然后编译其维护中的 TypeScript。上游源码归档提供原始编译器设置、runner schema 与类型声明，以及真实的未发布测试辅助工作区。[upstream-build.patch](patches/upstream-build.patch) 记录严格的独立构建配置；源码发现范围保持完整。Instrumenter 先编译，以便 core 解析其生成的声明。

Core 在自身运行时依赖中声明 `jsonc-parser`。它的[本地 tarball](artifacts/stryker-core-10.0.0-ts7-source-repair.tgz) 在 Bun 解析依赖前提供包元数据。Bun 的包补丁机制不会将该依赖加入已解析的依赖图；根目录声明不能替代 core 的依赖归属。生成的 [instrumenter 补丁](artifacts/@stryker-mutator%2Finstrumenter@10.0.0.patch)和 [runner 补丁](artifacts/@stryker-mutator%2Fvitest-runner@10.0.0.patch) 均同时包含源码和编译器输出。[构建 manifest](build/package.json) 则独立拥有重建与回归测试依赖，包括 instrumenter 所需的 `estree-walker` 类型输入。

根 manifest 安装此 core 归档和两个生成的补丁。[已安装包验证](verify-installed.mjs) 会逐个检查包文件是否与生成的清单一致，并检查归档与补丁摘要、共享 API 身份、CLI 入口和 core 的解析器依赖。它还会根据补丁生成的标识符验证 Bun 的空补丁标记。常规[发行包测试](../../scripts/stryker-distribution.spec.ts) 会通过根安装运行此验证和原生变异计数用例。

[Core 源码补丁](patches/core-source.patch) 负责静态变异激活、严格的 JSONC 配置解析和报告器注入类型保留。[Runner 源码补丁](patches/vitest-runner-source.patch) 负责按配置使用原生进程池、向子进程传递激活信息、基础设施错误分类和资源释放。[Instrumenter 源码补丁](patches/instrumenter-source.patch) 保留调用和 throw 删除候选，即使其参数也会产生变异，并使用 Babel 8 内置的 `import.meta` 解析支持。三个包的内容均保留上游 Apache-2.0 许可证文件；上游测试辅助工作区声明 ISC，仅用于构建和测试。这些发行包需要在仓库的[生成声明](../../THIRD_PARTY_NOTICES.md)中明确披露。

主要维护参考资料包括 [Bun 安装](https://bun.com/docs/pm/cli/install)、[Bun 包归档](https://bun.com/docs/pm/cli/pm#pack)、[Bun 归档解压](https://bun.com/docs/runtime/archive)、[Vitest 5.0.1](https://github.com/vitest-dev/vitest/releases/tag/v5.0.1) 和 [jsonc-parser](https://github.com/microsoft/node-jsonc-parser#api)。

-----

<a id="verification-limits"></a>

## 验证限制

所维护的回归测试覆盖真实 fork、工作目录切换、JavaScript 与 TypeScript 子进程、启动与收集错误、浏览器与 React 执行、进程内按测试收集覆盖率、静态初始化、超时清理，以及随后执行的原始基线。[变异计数测试](runtime/mutation-accounting.test.mjs) 要求同时保留调用或 throw 删除变异和参数变异，并在原生子进程中执行每一个生成的候选。它们验证此发行包的行为；其中小型变异测试 fixture（测试前置数据）不衡量仓库的变异测试验收结果。

子进程继承激活的变异标识符，但不会返回覆盖率或命中计数。子进程测试套件必须以 `coverageAnalysis: off` 运行全部测试；显式构造且不包含该标识符的子进程环境保持不变。原生 Windows、VM 池和较旧 Vitest 版本尚未验证。

浏览器日志保留两类框架警告：Vitest 的拦截器从 `applyToEnvironment` 返回 Vite 专用的 `configureServer` 钩子，以及 Vite 无法分析优化后的模块运行器中的动态导入。回归测试通过不代表浏览器执行没有警告。请将这些诊断与变异分类分开审查。

<a id="dev-note"></a>

## 开发备注

无。
