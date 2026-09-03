# Agent Teams

[English](agent-team.md) | 中文

隐式 Root Team 领域、模型工具与宿主适配器共享的类型。[Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责身份、mailbox、task 与共享 checkout 决策；本页记录 [`packages/subagent/agent-team/src/types.ts`](../../packages/subagent/agent-team/src/types.ts) 中的字面持久形式。

## 身份与 roster

`TeamId` 是具有独立[品牌](core.zh.md#branded-ids)的 Root `SessionId`。`TeamTaskId` 在 Team 内按 `task-<n>` 单调分配；`TeamMessageId` 是全局随机值。teammate 的 Session id 始终是持久身份，而 `name` 是不可变的模型／UI 标签。

```ts type-equiv
/** Whole durable value written on every teammate lifecycle change. */
interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
}
```

每个 member 都从 `provisioning` 开始，并且只到达一个终态 roster phase：`active` 或 `failed`。运行时 `running`／`idle`／`inactive` 状态单独派生，绝不会重写该记录。

## 持久 mailbox

Lead Session 首先存储完整 queued message。只有 target 的 pending inbox 条目或已记录用户消息完成持久化，才会写入独立 acknowledgement event，queued-minus-delivered 因而构成恢复 mailbox。

```ts type-equiv
/** One peer message retained until its target Session records it. */
interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly delivery: 'quiet' | 'wakeup'
  readonly content: ContentBlock[]
}
```

target Session 会在 pending inbox 条目和最终用户消息上保留消息身份与发送者归因。跨 inbox 与历史折叠该 source 构成 target 侧去重键；模型可见的 framing 会重复 id 和发送者。

```ts type-equiv
/** Source retained by the target Session for durable mailbox de-duplication. */
interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}
```

## 共享任务 DAG

每条 task event 都存储完整快照。`revision` 是 compare-and-set 值，每次变更递增 1。`blockedBy` edge 必须指向未删除任务，并维持无环图。`writeScopes` 是规范化的路径前缀。它们是任务板的互斥键，而不是文件系统锁：不会有两个任务在重叠前缀上同时处于 in_progress，但也没有任何机制阻止进程写到它所认领范围之外。

```ts type-equiv
/** Whole durable task snapshot; every mutation increments {@link revision}. */
interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
}
```

`pending` 表示尚未开始或已经释放，`in_progress` 携带 owner，`completed` 满足 blocker，`deleted` 是保留的 tombstone。view 会添加 owner name、readiness 和 write-scope 重叠警告，但不会改变持久快照。

## 认领工作

swarm 中的队友是主动拉取工作，而不是被指派。`claimNextReadyTask()` 取走第一个未被阻塞的 pending 任务，且其写入范围没有任何 in_progress 任务已经持有；该操作与其他所有任务板变更处在同一个按 Lead 的事务中，因此同一个 Lead 团队中的两个成员绝不会认领到同一个任务。该事务是一条持有在 Lead 自己进程内的 promise 链，而 `tryMembership` 只在 `ctx.agents` 仍持有那个完全相同的活动 Agent 时才接纳成员，因此这项互斥覆盖的是单个宿主进程，并非分布式锁。

```ts type-equiv
/** Outcome of one atomic claim-the-next-ready-task attempt. */
type ClaimNextTeamTaskResult =
  | {
    readonly outcome: 'claimed'
    /** The task this caller now owns, at its committed revision. */
    readonly task: TeamTaskView
  }
  | {
    readonly outcome: 'none'
    readonly reason: TeamTaskClaimUnavailable
    /** Unblocked pending tasks skipped because their write scopes are busy. */
    readonly deferred: TeamTaskId[]
  }
```

两种 `none` 原因都不是失败。`no-ready-task` 表示所有任务都已完成、已被拥有或仍被阻塞；`write-scope-conflict` 表示存在就绪的工作，但它会写到另一个成员正在写入的位置，并在 `deferred` 中列出这些任务，使调用方可以等待它们，而不是盲目轮询。

## 回放

`foldTeam()` 把一个 Root Session 回放成每个 Team 操作所读取的 roster、任务板与 queued-minus-delivered mailbox。它按 `TeamId` 选取记录，因此普通 fork 继承的 event 保留 ancestor id，绝不会进入新 Root 的状态。Session event 的 `seq` 与 `time` 继续负责顺序和时间记录，Team snapshot 不再重复保存它们。roster 与 task 读取以 view 形式到达调用方，而 pending 邮件仅供投递与恢复内部使用。包 [README](../../packages/subagent/agent-team/README.zh.md)负责 operation、authorization、recovery 和限制行为。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `bun run verify-cordis-catalog` in doc-sync; regenerate with `bun run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentteams--teamservice"></a>

### `ctx.agentTeams` — `TeamService`

Agent Teams service backed by the exact live Lead Session log.

```ts cordis-catalog
/**
 * Resolve one exact live Agent's Team role.
 * @param agent - exact live Agent used as the authority credential.
 * @returns its root, Team identity, role, and model-facing name.
 */
membership(agent: Agent): TeamMembership

/**
 * List the runtime-enriched roster visible to one Team member.
 * @param agent - exact live Team member.
 * @returns Lead and teammate rows in creation order.
 */
listMembers(agent: Agent): TeamMemberView[]

/**
 * Create one named, continuable direct child of the Team Lead.
 * @param caller - exact live Lead Agent.
 * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
 * @returns the active roster row.
 */
async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>

/**
 * Queue one durable peer message, then attempt immediate delivery.
 * @param caller - exact live sending Team member.
 * @param request - target name, content, scheduling mode, and pre-queue cancellation.
 * @returns durable message identity and immediate-delivery observation.
 */
async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>

/**
 * Create one unowned pending task in the Team Lead log.
 * @param caller - exact live Team member creating the task.
 * @param request - task text, blockers, and advisory write scopes.
 * @returns the revision-one task view.
 */
async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Return one task, including a deleted tombstone.
 * @param caller - exact live Team member reading the task.
 * @param id - Team-local task identity.
 * @returns the latest task value and derived readiness diagnostics.
 */
getTask(caller: Agent, id: TeamTaskId): TeamTaskView

/**
 * List current non-deleted tasks in numeric creation order.
 * @param caller - exact live Team member reading the board.
 * @returns detached current task views.
 */
listTasks(caller: Agent): TeamTaskView[]

/**
 * Take ownership of the first ready task whose write scopes are free, in one
 * atomic Lead transaction. A member pulls work with this instead of being
 * assigned it; concurrent callers therefore receive disjoint tasks. A ready
 * task writing where in-progress work does is deferred here and refused by
 * {@link updateTask}, so no route hands two owners the same paths.
 *
 * The transaction serializes callers inside one host process. Membership
 * requires the exact live `Agent` this process holds, so a second process
 * running against the same session log is outside the exclusion.
 * @param caller - exact live Team member taking ownership.
 * @returns the claimed task, or the ordinary board state — no unblocked
 *   pending task, or every one of them writing where in-progress work does —
 *   that left nothing to take.
 */
async claimNextReadyTask(caller: Agent): Promise<ClaimNextTeamTaskResult>

/**
 * Compare-and-set one authorized task transition. A transition that would
 * leave the task in progress while its write scopes overlap another
 * in-progress task is refused with `TEAM_TASK_WRITE_SCOPE_CONFLICT`, so
 * `claim`, `reassign`, and a scope-widening `edit` are bound by the same
 * exclusion {@link claimNextReadyTask} applies.
 * @param caller - exact live Team member authorizing the mutation.
 * @param request - task identity, expected revision, action, and action fields.
 * @returns the committed next task revision.
 */
async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Wait for the next Team-domain or member-status change.
 * @param caller - exact live Team member waiting for activity.
 * @param timeoutMs - bounded wait duration from ten seconds through one hour.
 * @param signal - caller cancellation for the wait only.
 * @returns one observed change or a timeout result.
 */
async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>

/**
 * Interrupt one live teammate turn without clearing its pending inbox.
 * @param caller - exact live Lead Agent.
 * @param targetName - durable teammate name.
 * @returns the target status sampled before cancellation.
 */
interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'idle' | 'inactive' }

/**
 * Resolve a caller without throwing, used by scoped-tool installation and observers.
 * @param agent - candidate exact live Agent.
 * @returns Team membership, or undefined for non-Team subagents and stale identities.
 */
tryMembership(agent: Agent): TeamMembership | undefined

/**
 * Read the current roster and non-deleted task board through the generated Remote API.
 * @param agent - exact live Team member used as the authority credential.
 * @returns detached current roster and task views.
 */
@Remote('view') remoteView(agent: Agent): TeamView

/**
 * Create one shared task through the generated Remote API.
 * @param agent - exact live Team member creating the task.
 * @param request - task text, blockers, and advisory write scopes.
 * @returns the revision-one task or a typed Team rejection.
 */
@Remote('createTask') remoteCreateTask(agent: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskMutationResult>

/**
 * Apply one task mutation and preserve Team rejections as business results.
 * @param agent - exact live Team member authorizing the mutation.
 * @param request - task identity, expected revision, action, and action fields.
 * @returns the committed task or a typed Team rejection.
 */
@Remote('updateTask') remoteUpdateTask(agent: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskMutationResult>
```

Types: [Agent](core.zh.md)

Source: [`packages/subagent/agent-team/src/index.ts`](../../packages/subagent/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
