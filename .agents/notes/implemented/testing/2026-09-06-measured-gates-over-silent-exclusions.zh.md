# Agent Note: 静默的门禁排除项改为可测量的门禁

Status: implemented

[English](2026-09-06-measured-gates-over-silent-exclusions.md) | 中文

## Problem

有四项检查在报告通过的同时，实际测量的范围小于其名称所声称的范围。

[`knip.json`](../../../../knip.json) 带有 `"exclude": ["duplicates"]`，既没有注释，也没有 Agent Note，更没有其他检查覆盖该问题类型，因此 knip 的重复导出检测器在整个仓库范围内处于关闭状态。其背后藏着一处真实的重复：[`image-layout.ts`](../../../../packages/experimental/webworker-runtime/src/image-layout.ts) 中的 `WRAPPER_PARAMS`，其自身 JSDoc 写明它的存在是为了让既有导入保持不变——正是发布前立场所禁止的兼容性垫片。

在清单不再声明 `@stryker-mutator/vitest-runner` 之后，[`ROOT_DEPENDENCY_FLOORS`](../../../../scripts/live-stack-floors.ts) 仍然列着它。`rangeMisses` 会跳过找不到的名字，因此该条目什么也没有评估，而它的 JSDoc 却声称该映射按构造是完整的；完整性只在一个方向上被断言。

[`browser-locale`](../../../../packages/util/browser-locale/src/index.ts) 中有一条 `Stryker disable next-line ArrayDeclaration` 注释。它抑制的变异体确实是等价变异体，但抑制是变异测试层的逃生舱：它记录了某个变异体无法被杀死，而不是移除使其无法被杀死的那段构造。

## Decision

每个空洞都改为可测量的东西。

`bun run verify-duplicate-exports`（[`knip-duplicate-exports.ts`](../../../../scripts/knip-duplicate-exports.ts)，hygiene 通道）运行 knip 自己的重复检测器，并对每一行分类。同一绑定的两个名字只有在其中一个是 `default` 时才通过——即 Cordis 插件约定：Service 类按名字导出以供类型使用，同时作为 `default` 导出供 `ctx.plugin()` 使用——或者该文件出现在按名字限定的例外清单中，目前其中只有那个必须发布 `ws` 包自身 `WebSocketServer` 与 `Server` 两个名字的存根。其余一律失败。knip.json 中的排除项保留，因为 94 行实时结果中有 93 行属于该约定，全仓库失败只会教会读者忽略这道门禁；改变的是被排除的这一类现在在别处被测量，并在 [`docs/development.zh.md`](../../../../docs/development.zh.md) 中写明。

`staleRootDependencyFloors` 与 `stalePinnedProductFloors` 补上了下限映射的第二个方向：一条指向任何清单都不声明的依赖的下限，现在是失败，而不是被静默跳过的行。`WRAPPER_PARAMS` 已删除，其唯一消费方改读 `MODULE_PARAMS`。

`resolveBrowserLocale` 采用重构而非抑制。那个两个变异体都无法被任何测试区分的 `??`，改成了显式的 `browser.languages === undefined` 分支；空数组回退改成了提前 `return 'en'`。这些行上剩余的每个变异体都可被杀死，并新增了两个杀死它们的测试——一个是报告空 `languages` 列表的嵌入方，另一个是显式标签覆盖实时浏览器。

## Alternatives considered

**删除 `"exclude": ["duplicates"]`，让 `bun run knip` 报出全部 94 行。** 否决：其中 93 行是框架要求，这道门禁会在正确的代码上永久失败，一周内就会被绕开。

**基于 TypeScript AST 手写一个重复导出扫描。** 依据"优先使用已维护依赖而非手写"的政策否决：knip 已经计算了这个结果，第二份实现会与它漂移。

**保留 Stryker 抑制并说明该变异体为何等价。** 否决：那条注释本来就是准确的，但它仍然在该层中留下了一段任何断言都无法触达的构造。这里可以移除该构造，代价是三行。

**通过列出预期名字来断言下限映射的完整性。** 否决：被复制的预期清单会被编辑成与清单当前内容一致，而这正是该映射要防止的失效方式。从清单双向推导则无法这样被满足。

## Consequences

新增一个根依赖仍然强制要求给出下限；移除一个则现在强制要求删除它。一个把同一绑定用两个名字导出的模块会导致 hygiene 通道失败，除非它是插件约定，或以其确切的名字集合列入 `NAMED_ALIAS_EXCEPTIONS`——该清单按文件限定，不可被继承。`bun run verify-duplicate-exports` 约耗时 45 秒，因为它驱动一次完整的 knip 分析，这也是它放在 hygiene 而非单元通道的原因。今后在 `packages/util/*/src` 中出现变异体抑制，是需要改动源码而非测试的信号。
