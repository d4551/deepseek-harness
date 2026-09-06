# Agent Note: swarm 队友在任务板不再有 pending 任务时停止拉取

Status: implemented

[English](2026-09-07-swarm-teammates-stop-on-exhausted-board.md) | 中文

## Problem

`packages/subagent/tool-agent-team` 中的 swarm 策略要求队友用 `team_task_claim_next` 认领任务，并在没有可领任务时"使用 wait_agent，然后再次认领"。它从未说明何时停止。`claimNextReadyTask()` 对两种不同的任务板只报告一个原因 `no-ready-task`：一种是仍有 pending 任务被进行中的工作阻塞，此时等待是正确的；另一种是每个任务都已完成或已被其他成员拥有，此时队友无论等待什么都不会让任务变得可认领。队友不列出任务板就无法区分这两种情况，而策略也没有要求它这样做。

`wait_agent` 把轮次进行中的成员计为 `running`，而处于 `wait_agent` 中的队友正是如此。因此耗尽的任务板上的两个队友会互相维持存活：各自看到对方在运行，等到超时，重新列出，什么也认领不到，再等待，每个循环一次模型请求，只要会话存活就一直持续。Lead 给出回答后，单个队友的情况更糟：没有活动的同伴时 `wait_agent` 立即返回 `noProgress`，策略要求再次认领，于是循环毫无延迟地空转。在 headless 的 `swarm` profile 中进程随 Lead 的回答结束，所以那里看不到这个循环；在 `swarm-web` 中会话在回答之后继续存在，队友便持续消耗 token。

## Decision

`TeamTaskClaimUnavailable` 有三个值，每个值都告诉调用方等待是否有用。`no-pending-task` 表示不再有 pending 任务：每个任务都已完成或已被其他成员拥有，因此在有任务被创建、释放或重新打开之前不会有任何任务可认领。`no-ready-task` 现在只表示每个 pending 任务都被仍在进行中的工作阻塞。`write-scope-conflict` 不变：存在就绪的工作，但它会写到另一个成员正在写入的位置，`deferred` 会列出这些任务。`TeamTaskBoard.claimNextReady` 统计它因未就绪而跳过的 pending 任务，并根据该计数和 deferred 列表选择原因，因此这一区分是在决定认领的那个事务中计算出来的，而不是由模型从之后的列表中推断。

swarm 策略用队友自己的措辞说明停止规则：`no-ready-task` 与 `write-scope-conflict` 表示 `wait_agent`，然后再次认领；`no-pending-task` 表示用一份简短的完成情况报告结束本轮，而不是等待。Lead 的段落说明队友会在不再有 pending 任务时结束本轮，因此之后再创建任务时必须用 `followup_task` 唤醒队友；还说明拥有者已不活跃的任务不会自行完成，必须释放或重新分配。工具描述携带同样的三个原因，输出 schema 枚举了它们；delegated 策略不变，因为它的队友是被点名指派工作的。

## Alternatives considered

**要求队友在等待前列出任务板。** 拒绝：每次空认领都要多付出一次工具调用和一次模型请求，而任务板在认领事务内部已经知道是否还有 pending 任务。

**让 `wait_agent` 在没有 pending 任务时对队友返回 `noProgress`。** 拒绝：`wait_agent` 同样观察 mailbox 与 roster 的变化，队友完全可能在合理地等待 Lead 的消息。认领结果才是唯一知道认领为何一无所获的地方。

**保留两个原因并在结果中增加一个 `pending` 计数。** 拒绝：模型把原因当作指令来读，一个需要与零比较的计数，不如一个直接说明下一步该做什么的名称。

## Consequences

swarm 队友在任务板耗尽时结束本轮，因此 `swarm-web` 会话在工作完成后不再运行无界的认领加等待循环，Lead 也被告知在新增任务时如何唤醒已完成的队友。`no-ready-task` 的含义收窄：以前把它读作"什么都不剩"的调用方，现在对那种任务板会收到 `no-pending-task`，工具描述、子系统页面和 swarm 层 README 都说明了这一点。此变更只影响挂载 Team 工具的组合，而没有任何已交付的默认组合会挂载它们，所以没有录制快照发生变化；swarm profile 仍然没有录制会话，因为录制需要模型密钥，其 Loader 真实组合测试以及 Team service 与工具套件承担覆盖。这些套件固定了空任务板、唯一 pending 任务被进行中工作阻塞的任务板、以及每个任务都已被拥有的任务板上的三种原因，工具套件还固定了渲染后策略中的停止规则。
