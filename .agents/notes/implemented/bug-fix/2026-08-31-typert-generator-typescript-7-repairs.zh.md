# Agent Note: Restore typert generator invariants after TypeScript 7

Status: implemented

[English](2026-08-31-typert-generator-typescript-7-repairs.md) | 中文

## Problem

TypeScript 7 迁移让 typert generator 适配了新的 AST 与 project API，但若干不变量没有随之保留，而 generator 自己的测试套件无法报告这一点：它的 vitest worker 耗尽默认 V8 堆并被杀，失败因此不可见。在放大堆上限后，工作区分析峰值达到 8.3 GB，catalog 与 doc-graph gate 根本无法运行。

## Decision

**每个 face 一张编译图，而不是每个文件一张。** `indexSourceDeclarations` 为每个包打开一个 project，在此之前还为每个文件打开一次 session 快照，留下数千张存活的图。它现在运行在 face program 上——该 program 本就覆盖注册到该 face 的每个包——并由 `WorkspaceCaches.release` 丢弃已记忆的 project，使分批与包级检查都无法长期持有。`scripts/cordis-walk` 出于同样原因在一次快照中打开其全部文件集合。Client catalog 从 8.3 GB、64 秒降至 0.37 GB、4 秒，host catalog 从内存溢出中止降至 0.84 GB，doc graphs 降至 2.0 GB。

**write 模式在初始化器之前标注参数。** `annotationPosition` 会落到参数末尾，而该位置位于初始化器之后，于是 `--write` 生成了 `echo(input = 'value': string)`——无法解析的源码。

**被拒绝的 aggregate 配置在加载时失败。** TS7 的 `parseConfigFile` 只回答文件名，因此格式错误的配置或非法选项值只会产生空发现而没有诊断。`configFileDiagnostics` 打开该配置、读取 `getConfigFileParsingDiagnostics` 再关闭；文件变更在独立快照中声明，因为在同一次更新中打开的 project 仍以 session 此前持有的内容构建。

**空的 Cordis augmentation 不是接口面。** 包发现依据词法标记接纳文件；若某文件唯一的标记是没有成员的 augmentation，它什么都没有声明，该包不进入发现结果。

**无法建模的 Context 成员明确失败。** 当服务类型既不是 class 也不是 interface 时，解析返回 `undefined`，这会让已声明的服务从 catalog 中静默消失。在声明它的包内这现在是一次拒绝；引用其他包所声明服务的成员仍被跳过，因为那个包会为它建模。

**环境声明属于 face program。** 包通过 `types` 或 `typeRoots` 引入 `.d.ts` 文件；face program 此前只接纳包 `src` 下的文件，于是这些文件声明的全局类型解析不到任何声明。

已记录的模型快照中保留了写入它们的那台机器的绝对路径，这违反 `symbolId` 自身"id 相对仓库根"的规则；它们已按相对路径重新记录。跨包类型曾经通过 `dsh-client-ui-chat` 与 `dsh-extensions-ui-cordis` 中的本地再导出 barrel 抵达 Typert 建模位置；这些位置现在从声明它们的包导入，这正是分析器所要求的。

## Alternatives considered

**让分析器接受再导出其他包类型的相对 barrel。** 已否决：测试套件刻意固定了这条拒绝，因为生成的 import 必须指名拥有该类型的包。缺陷在那些 barrel 使用点。

**为 generator 的 gate 放大堆上限。** 已否决：`scripts/ci-workflow.spec.ts` 断言 CI 中不出现 `--max-old-space-size`，而且这是持有缺陷而非规模问题。

**保留迁移期间记录弱化行为的那些测试。** 其中两个在相同 fixture 上与更早的用例相互矛盾——被容忍的格式错误配置与被容忍的非 class 服务成员。它们记录的是迁移做了什么，而不是本 Harness 要求什么，而这里的配置错误必须明确失败。

**直接接受 `-u` 重新记录的快照。** 未经阅读即否决：同一次运行还重写了已变成绝对路径的 id，其中只有路径规范化与新增的 `@param` 参数名是正当的。

## Consequences

Generator 套件能在默认堆上跑完并通过，因此它所编码的不变量重新被强制执行，而不是被死掉的 worker 掩盖。Catalog 与 doc-graph gate 在默认堆内数秒完成。write 模式产出可解析的标注。若某 profile 或工作区的 aggregate 配置被编译器拒绝，现在会在加载时以编译器自己的消息失败，而不是什么都不分析。
