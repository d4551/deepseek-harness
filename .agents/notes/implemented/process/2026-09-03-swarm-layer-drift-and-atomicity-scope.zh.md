# Agent Note：两项比代码更宽的 swarm 说法，以及一份没有门禁看得见的分叉

Status: implemented

[English](2026-09-03-swarm-layer-drift-and-atomicity-scope.md) | 中文

## 问题

一次针对 swarm 模式的审计返回 DONE，随后点名了该交付项没有了结的两件事。

`docs/subsystems/agent-team.md` 写道 `claimNextReadyTask()` 运行"under the same per-Lead transaction every board mutation uses, so two members can never claim one task."。该事务是持有在单个进程内的一条 promise 链，而 `roster.tryMembership` 只在 `ctx.agents` 仍持有那个完全相同的活动 `Agent` 时才接纳成员，因此这项互斥覆盖的是单个宿主进程。无论那一页，还是 `claimNextReadyTask` 与 `claimNextReady` 上的两处 JSDoc 契约，都没有说明这一点；而 `freshProvider` 与 `forkProvider` 是自由格式字符串，反倒诱导出更宽的理解。

`packages/preset/swarm-profile/cordis.patch.yml` 是 `agent-team-profile` 那份 40 行 patch 的 49 行近似副本。全部差异是一段头部注释、一行设置 `maxConcurrentRuns: 8` 的 `subagent` 行、`maxMembers` 由 8 改为 16，以及 `coordination: swarm`；针对全局可续子进程工具的 disable 行与 `agent-team` insert 完全相同。`bun run duplication` 读的是 TypeScript，因此仓库里没有任何东西看得见它。base 的 subagent 行一旦改名，两个文件都要改；而目标行缺失的 patch 按设计只停留在 Loader 警告——于是这次遗漏会表现为 swarm 模式带着两个 `list_agents` 启动，外加 stderr 上的一行。

## 决定

三处散文现在都说明该互斥是进程内作用域，并点明使它成为进程内作用域的机制：一条位于本进程的 promise 链，以及要求本进程持有那个完全相同的活动 `Agent` 的成员资格。

一个独立的 profile 层必须自包含——bundle 只声明 `dsh.bundle.patch`，没有任何办法要求一个前置层，因此把 swarm 拆成叠在另一层之上的增量，会让单独应用它的用户得到一条警告而不是一份可用的组合。那份副本本身已不存在：`dsh-base` 为每个 profile 挂载 Team 行，`agent-team-profile` 已删除（[Agent Teams 随每个 profile 交付](../architecture/2026-09-07-agent-teams-in-every-profile.zh.md)），因此 swarm 层重新调校 base 的行，副本所需要的读者变成了与 base 的比较。

`declares a publishable layer that retunes only rows dsh-base mounts` 读取 `dsh-base` 的 patch，断言本层针对的每个 id 都存在于其中，从而把那条按设计的警告变成本层的失败。`changes exactly its documented values and restates every other key` 把每个重新调校的行与 base 自己的行比较，断言差异恰好是记录在案的那个值，因为 patch 会替换整行的 config。

把 `maxConcurrentRuns` 从 8 改成 9 只会让记录值用例失败；把某一行改为针对 base 未声明的 id，则基础配置行 id 断言失败。

## 备选方案

**把 swarm-profile 拆成叠加在 agent-team-profile 之上的增量。** 这是这段关系的诚实形状，组合顺序也支持它，但没有任何机制强制用户同时加入两者，而只加 swarm 的失败模式是警告，不是拒绝。一份受检查的副本比一项无法强制的依赖更安全。

**教重复检测门禁读 YAML。** jscpd 支持更多格式，但本仓库中被标记的区域都是 TypeScript，而打开一个语料从未被度量过的格式，会一步落下数量未知的发现。这两个测试现在回答了这一对；扩大门禁是它自己的改动。

**让缺失的 patch 目标使加载失败。** 该警告的存在，是为了让一份 overlay 能在并非都带有相同行的多个表面之间共享——这是有自身笔记记录的真实需求。为修一个层而在全仓库范围改动它，等于用一项无记录的取舍换掉一项有记录的取舍。

## 影响

原子性说法在子系统页面与两个调用点都写明了作用域。swarm 层不能针对一个不再存在的 base 行，也不能偏离 base 所组合的取值，否则会有测试失败。
