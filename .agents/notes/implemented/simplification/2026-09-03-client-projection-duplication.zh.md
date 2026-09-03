# Agent Note: 客户端中哪些「独立投影」说法经受住了 diff 对比

Status: implemented

[English](2026-09-03-client-projection-duplication.md) | 中文

## 问题

移除仓库中的 `jscpd:ignore` 标记后，`packages/client` 暴露出 24 处克隆，分布在四个簇里。每个簇都带着声称该重复是有意为之的说明文字：「Chat 与 Trajectory 各自拥有独立的事件到视图投影」、「UI Subagent 与 UI Workspace 各自独立投影自己的视图」、「Approval 与 Question 有意各自拥有独立的待结算生命周期」，以及一条关于并列 TypeScript 重载的注释。这些注释是压制标记，不是证据，因此在抽取任何代码之前，每条说法都先对照被重复的代码行做了核验。

## 决策

客户端 bundle 纯度门禁会拒绝任何不是模块表行的 `@deepseek-ai/` 值导入，因此共享所有方必须是消费方能够请求到的包。`dsh.client.external` 就是这个机制：`stripClientSuffix` 把 `<pkg>/client` 映射到该包自身的图行上，`orderByModuleGraph` 把该行排在其消费方之前。这里选定的两个所有方本就被每个消费方注入，因此该请求既不新增插件依赖边，也不需要改动纯度门禁。直接调用门禁的 `resolveId` 可以确认这种不对称：四个声明包把 `@deepseek-ai/dsh-client-ui-session/client` 解析为 null（外部），未声明的包仍然抛错。

`@deepseek-ai/dsh-client-ui-session/client` 拥有 `indexSubagentDescendants`（对它本就适配的 Session Controller 列表做的一次折叠）以及 `settlePendingComposer` / `settlePendingInteraction`（它本就拥有 `registerPendingInteraction`）。

`@deepseek-ai/dsh-client-ui-conversation/client` 拥有 `src/client/projection/`：`event-projection.ts`、`assistant-stream.ts`、`tool-calls.ts` 和 `messages.ts`。这些函数构建的每一种记录类型——`AssistantBlock`、`AssistantMessageNode`、`RunningToolCall`、`ToolResultNode`、`ContextProvenanceView`——本就由它声明，因此投影现在与它产出的记录同处一包。共享 `toolCallMatch` 需要 Code Dispatch 的事件词汇，而只有 `@deepseek-ai/dsh-tools` 声明它；该包以仅类型的对等依赖（peer dependency）形式加入，与该包已经为 `dsh-session`、`dsh-llm` 和 `dsh-tool-todo` 导入的宿主平面类型一致。

## diff 对比显示了什么

四条说法中三条不成立，一条成立。

**UI Subagent / UI Workspace：不成立。**两个包里的 `subagent-lineage.ts` 除模块文档注释中的所有方名称外逐字节相同。两个消费方都从同一个 Session Controller 折叠同一份 `SessionListState['byId']`。所谓「独立视图」指的是两个渲染器，而它们从来就不是被重复的那部分代码。

**Approval / User Questions：不成立。**`settlePendingComposer` 逐字节相同，两个 `answer*` 函数围绕 `uiSession.registerPendingInteraction` 走的是同一套 publish/await/delegate/cleanup 生命周期。生命周期完全一致，不同的只有待处理值的构造方式和结果类型。

**Chat / Trajectory：关于遍历不成立，关于视图成立。**`event-projection.ts` 与 `trajectory-event-projection.ts` 的逻辑没有一行分歧：唯一的结构差异是 `sessionRecallLabels`，Chat 有而 Trajectory 没有。`assistant`、`tool`、`message` 和 `inbox` 的定义确实分歧，但不在被标记的区域里——被标记的是块累加器、工具调用记录构造器、子调用边规则、inbox 折叠和消息分类。两个目标遍历同一批事件、构建同一批中间值，直到构造视图时才分开。阅读这些区域还得出两项发现：合成 seq 偏移量在 Chat 中是一张具名表，在 Trajectory 中是同样的裸数字（`-0.9`、`-0.8`）；Chat 的 `closedBoundary` 带有一个 `end !== undefined` 守卫，而 `ConversationLocationIndex` 使它不可达，因为该索引恰好在 `end !== undefined` 时设置 `status: 'closed'`。

**`ui-slots` 的 register 重载：成立，并且现在有了实测结果。**这两个重载重复同一份类型参数列表，因为 TypeScript 无法让它们共享一份。把它们折叠成带可选 `inject` 的 `I extends object = object`，在全部 44 个客户端包上都能通过类型检查，而这正是陷阱所在：它会把七处 `@ts-expect-error` 变成未使用的指令（`ui-slots/tests/type-chain.client.spec.tsx` 的第 204、208、216、222、243、250 行，以及 `ui-conversation/tests/views-type-chain.client.spec.tsx` 中的一处）。在 `inject` 缺失时推断 `I`，会把组件约束放宽到足以接受不匹配的 renderSlot 键、不匹配的 store 共享、漂移的 select 返回值以及缺失的业务面。这九行重复代码保留下来，代码处的注释现在记录的是这项实测结果，而不是一句断言。

## 各目标仍然各自拥有什么

剩下的分歧是真实的，并且在各处都有说明。Chat 保留 `hidden`，这个重试压制标志让一个步骤在重试丢弃其可见内容之后仍保持挂载；它把调用图存为嵌套块，并用 `WeakMap` 备忘以保持引用稳定。Trajectory 保留一条账本行所报告的请求生命周期——`startSeq`、`started`、`sawChunk`、跨重试累计的用量、待处理的重试、收尾的 `step/end`——并把调用图存为以 id 为键、带邻接表的表，使一行无需遍历整棵树就能向上查一层调用。Chat 只接受追加面的 `tool/result` 事件，因为被替换的结果属于被遮蔽的历史；账本接受每一条被记录的结果。Chat 从匹配到的 `step/start` 事件开始为步骤计时，且不展示提供方身份；Trajectory 从它自己记录的起点计时，并报告是哪个提供方和模型作答。

对于不改变任何块的分片，`applyAssistantChunk` 返回 `null` 而不是一个状态。正是这一点让 Chat 能原样记录 `usage`、Trajectory 能跨重试累加它，而两者共用一个累加器。

## 覆盖率

Chat/Trajectory 这处重复的两侧本就处在 GUI 债务覆盖率豁免之下（`packages/client/ui-chat/src/client/conversation-nodes/*` 和 `packages/client/ui-trajectory/src/*`；vitest 会把结尾的 `*` 递归展开），`packages/client/ui-conversation/src/client/*` 以同样方式覆盖新的 `projection/` 目录，因此门禁的实测集合没有变化。抽取让这些逻辑可以被直接测试，于是现在它们被直接测试了：覆盖掉那些豁免后，四个投影模块在语句、分支、函数和行上都达到 100%。原先既无所有方也无直接测试的逻辑，现在两者都有。

## 考虑过的替代方案

**为每个新所有方添加一条 `INLINE_SAFE` 记录。**该白名单按子路径锚定，服务于浏览器 bundle 会内联的协议层。`dsh.client.external` 才是面向「消费方已经请求的包」的机制，而这里每个消费方都已经注入了两个所有方，因此该请求不新增插件依赖边，纯度门禁也无需改动。直接调用门禁的 `resolveId` 可以确认这种不对称：四个声明包把所有方子路径解析为 null，未声明的包仍然抛错。

**折叠 `ui-slots` 的 register 重载。**它在全部 44 个客户端包上都能通过类型检查，而这正是它成为陷阱的原因：它会把七处 `@ts-expect-error` 变成未使用的指令，因为在 `inject` 缺失时推断 `I`，会把组件约束放宽到足以接受不匹配的 renderSlot 键、不匹配的 store 共享、漂移的 select 返回值以及缺失的业务面。九行重复代码比这样的暴露面代价更小。

**除遍历外，把 Chat 与 Trajectory 的视图构造也一并抽取。**这两个视图是真正不同的约定——一个把调用图存为供渲染使用的嵌套块，另一个存为以 id 为键的表，使一条账本行无需遍历整棵树就能向上查一层调用——把它们耦合起来会让一侧的渲染决策约束另一侧。只有共享的遍历部分被移走。

## 后果

24 处克隆变成 1 处。六个包各减少一份副本；`ui-conversation` 与 `ui-session` 各新增一个所有方。`ui-conversation` 之外没有消费方引用的导出不会从它的 `./client` 边界再导出，因此发布出去的接口只按 Chat 与 Trajectory 实际导入的部分增长。

剩下的那处克隆是 `ui-slots` 的重载对，它被有意保留，上述实测结果记录在该处的注释里。
