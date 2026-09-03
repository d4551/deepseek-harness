# Agent Note: 钩子桥接器的公共管道移入协议库

Status: implemented

[English](2026-09-03-hook-bridge-and-invariant-plumbing-extraction.md) | 中文

## Problem

移除 `.jscpd.json` 的文件内抑制标记（[标记 Agent Note](2026-09-03-duplication-suppression-that-suppressed-nothing.zh.md)）后，两个钩子桥接器之间浮现出六处克隆：`hooks-claude-code/src/index.ts` 与 `hooks-codex/src/index.ts` 之间五处，两者的 `config.ts` 之间一处。

这些克隆就是除方言之外的整个桥接器：import 块；`runPoint` 主体——它匹配一个 group、追加 `hook/invoked`、运行命令、对未被兑现的字段发出警告、追加 `hook/result`、再做合并；`contextFrom` 与 `prependContext`；`lastTurn` 与 `blocksToText`；Codex 从 Claude Code 抄来的 `session_id`/`transcript_path`/`cwd`/`hook_event_name` 基础字段；游离运行的跟踪器及其排空 effect；配置读取、跳过警告，以及失败即中止注册的规则；还有 `agent/pre-step`、`tools/pre-execute`、`tools/post-execute` 与 `agent/turn-stopping` 上的四份决策映射，其中包括“仅携带上下文的结果走委派而非否决”这条规则。

有三条注释为维持这种状态辩护。`hooks-codex/src/index.ts` 写着 "Each dialect bridge keeps its complete dependency list visible at the entry point"、"Execution and decision mapping remain in each bridge so dialect differences stay explicit at their owning extension point"，以及 "sharing them would pull bridge-only agent/LLM dependencies into hook-protocol"。前两条描述的是读者为这份代价换来了什么；它们都不是约定，而代价是：对合并与记录路径的每一次修复都要做两遍，且这两个文件的文本本已漂移（CC 那份副本对 `updatedInput` 发出警告，Codex 那份把纯 stdout 转成上下文）。第三条为真，也正是实际代价：`dsh-hook-protocol` 不得不获得 `dsh-agent`、`dsh-llm`、`dsh-tools` 与 `dsh-session-persistence` 这四个对等依赖（peer dependency）。两个桥接器本就都声明了这四个，因此包依赖图上没有新增的边，而两个桥接器也都卸掉了不再发起的导入。

## Decision

`@deepseek-ai/dsh-hook-protocol` 拥有除方言之外的整个桥接器，分为四个新模块，并由其已发布的 `index.ts` 再导出。

`payload.ts` 拥有 `lastTurn`、`blocksToText` 与 `hookEventFields`，即两种方言都携带的四个身份字段；transcript（文本记录）缺失时的写法作为参数传入，因为 Claude Code 写 `''` 而 Codex 写 `null`。

`config.ts` 拥有 `parseHookGroups`，即带 matcher 校验的 event/group/hook 骨架，以及“`UserPromptSubmit` 与 `Stop` 在两种方言中都不携带 matcher 主体”这条规则，另有 `loadHookGroups` 与 `assertPositiveInteger`。每种方言只提供它支持的 event、它的 matcher 模式，以及一个转换原始 hook 条目的回调——Claude Code 在其中替换 `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}`，Codex 在其中拒绝 `async: true` 并接受 `timeoutSec` 别名。

`bridge.ts` 拥有 `startHookBridge`：它解析两个上限值，并在配置加载之前完成校验，使错误的上限值无法藏在加载的提前返回之后；它只读取一次配置，只为将会运行钩子的桥接器注册游离运行的排空 disposer，并返回 `HookBridge` 接口——或者返回 `undefined`，桥接器把它读作“什么都不注册”。`HookBridgeOptions` 写明方言要决定的内容：`dialect`、`plugin`、`trailingNewline`、它要对之发出警告的 `unhonored` 字段，以及可选的 `env`。

`extension-points.ts` 为每个共享扩展点各拥有一个注册器。每个注册器接收该方言的 payload 构造器，以及仅该扩展点会变化的那项能力：两个携带上下文的扩展点上的 `plainStdoutAsContext`，`PreToolUse` 上的 `honorAsk`。Claude Code 的 `subagent/start` 与 `subagent/end` 留在该桥接器内并直接驱动 `HookBridge`，因为 Codex 没有这两个扩展点。

每个桥接器保留自己的 payload 字段集、自己的配置条目转换、自己的 `Config` schema，以及自己的能力声明。面向模型的行为未变：警告文本、`<dialect>:<point>:<n>` handler id 以及每一份决策映射都逐字复现，计数器仍位于模块级别，因此 id 在多次 mount 之间保持唯一。

## Alternatives considered

**用一个 `registerHookBridge` 一次性接收全部扩展点。** 已否决：五个扩展点的选项并集会成为一个标志袋，其中 `honorAsk` 与 `plainStdoutAsContext` 读起来像是全局的桥接器设置，而不是关于某一个扩展点的事实。

**按注释的要求，让 payload 辅助函数留在各自桥接器内。** 已否决：`lastTurn` 与 `blocksToText` 完全相同，而一旦周围的函数搬走，把基础字段留在原地就会让 `base` 本身成为一处克隆。

**把新模块作为子路径导出发布。** 已否决：没有哪个消费方只需要其中一半，而 `index.ts` 已经是这个包已发布的边界，因此 `no-barrels` 允许这些转发。

## 不变量配套模块的提交前暂存：曾上报，现已解决

本次改动在 `compaction`、`hook-protocol` 与 `user-approval` 三个不变量配套模块之间留下三处克隆，并选择上报而不是重塑任何一侧。它们共享的文本是 `traces`/`staged` 这对 `WeakMap`、为既有会话播种的循环、`session/created` 与 `session/event` 监听器、`internal/dispatch` 提交前暂存，以及注册尾部。上报把约束说对了：五个包携带该管道，因此其所有者必须是这五个包都已依赖的包——也就是 `dsh-session`，它声明了 `Session`、`SessionEvent` 与这两个事件；因为[不变量契约笔记](../architecture/2026-07-19-package-invariant-runtime-contracts.zh.md)禁止 `dsh-invariants` 导入产品包。

此事后来正是这样完成的，见[暂存所有者笔记](2026-09-03-session-staging-plumbing-owner.zh.md)。这里提出的两项说法是错的，现予更正而非任其留存。原文称每处克隆约有一半 token 是 `verify-package-invariants` 逐字要求的注册尾部，因此那一半"不改门禁就无法移动"——实测下来，仅注册尾部为 11 行 46 个 token，低于 60 token 的下限，从未触发该门禁。另外，携带该管道的是七个包而非五个：`tool-todo` 与 `core/tools` 也持有它。

## Consequences

`bun run duplication` 不再报告这六处钩子克隆；在其他包的克隆被并行修复的同时，仓库总数从 20 降到 8。`packages/hooks/hook-protocol` 新增了四个对等依赖与四条项目引用；其 README 仍把这个包描述为一份协议格式（wire format），需要做同样的更新。`hooks-claude-code` 与 `hooks-codex` 的源码不再导入 `dsh-llm`、`dsh-session` 或 `dsh-session-persistence`，尽管两者仍然声明它们。`dsh-hook-protocol` 的新模块由两个桥接器的测试套件覆盖，而非由它自己的套件覆盖；仓库级覆盖率运行会把二者合并统计，逐包的覆盖率车道则不会。
