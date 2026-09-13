/** Scoped model-facing tools for the opt-in Agent Teams runtime. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamTaskId } from '@deepseek-ai/dsh-agent-team'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { FIRST_PARTY_SECTION_ORDER } from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { installSwarmCommand } from './swarm-command.ts'

/** Cordis plugin name. */
export const name = 'tool-agent-team'
/** Services required by the Team tool plugin. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt']

/**
 * How this deployment expects members to receive work. Both modes register the
 * same tools; the value selects the guidance the members are given.
 */
export type TeamCoordination = 'delegated' | 'swarm'

/** Tool routing configuration. */
export interface Config {
  /** Fresh continuation provider; omitted to discover a unique registered match. */
  readonly freshProvider?: string
  /** Fork continuation provider; omitted to discover a unique registered match. */
  readonly forkProvider?: string
  /**
   * Work distribution this deployment runs. `delegated` keeps the Lead handing
   * out work to named teammates; `swarm` has the Lead fill the shared board and
   * every teammate pull from it.
   */
  readonly coordination?: TeamCoordination
  /**
   * Agent preset ids whose Agents keep their preset's exact tool set: an Agent
   * whose session header names one of them receives neither the Team tools nor
   * the policy section. A deployment without agent presets composes no such
   * header, so every Agent is a member there.
   */
  readonly excludePresets?: string[]
}

/** Loader schema for the Team tool plugin. */
export const Config: z<Config> = z.object({
  freshProvider: z.string().min(1),
  forkProvider: z.string().min(1),
  coordination: z.union(['delegated', 'swarm']).default('delegated'),
  excludePresets: z.array(z.string()).default([]),
})

/** Model-facing collaboration guidance for a Lead that hands work to named teammates. */
const DELEGATED_POLICY = `Agent Teams is available in this session, but create teammates only when the user explicitly asks to use Agent Teams or teammates.

As the Lead, record each delegated responsibility with team_task_create before spawning its teammate. Include the task id, acceptance criteria, and expected result in that teammate's prompt. The teammate must read the task with team_task_get, claim it with team_task_update using its current revision, perform the work, then complete it and send_message the result to the Lead. If an assigned responsibility has no task record, create and claim one before doing the work. A spawn description is roster metadata; it does not create a shared task. The Lead owns decomposition, assignment, recovery, and synthesis; do not ask the user to operate the task board.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Claiming a task whose write scopes overlap a task already in progress is refused; complete or release that task first.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use send_message for quiet information that must not start an idle teammate. Use followup_task when the target should run another turn. A delivered peer item starts with its stable message id and sender name. A successful send is already durable even when its result says queued; do not resend it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. Before wait_agent, read list_agents and the task board. A waiting member cannot produce progress; unrelated workspace conversations do not justify waiting. Wake a required inactive owner with followup_task. wait_agent returns noProgress immediately when no productive member remains, and refuses repeated short waits at a previously timed-out activity cursor. A longer wait for a verified running owner must at least double the previous expired duration and fit the remaining one-hour quiet budget; the result reports both bounds. Meaningful progress resets that budget. Inspect or repair stalled work after timeout or noProgress; do not repeat a wait or claim loop without a concrete change. Never mark unresolved work complete. The Lead must wait for required teammates before giving the final answer.`

/** Model-facing guidance for many members working one request off the shared board. */
const SWARM_POLICY = `This session runs as a swarm: several teammates work one request at the same time and take their work from the shared task board instead of being told what to do. A /swarm request explicitly authorizes multiple teammates working concurrently; preserve that intent when planning and executing the request.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Give every task the write scopes it will touch, keep those scopes disjoint between tasks that may run at once, and use blocked_by when work must be ordered. A task whose write scopes overlap a task already in progress cannot be claimed until that task completes or is released.

As the Lead, decompose first and spawn second. Create one task per independently completable unit of work with team_task_create: a self-contained description that a member with no other context can execute, acceptance criteria, the write scopes it will modify, and blocked_by for anything it must wait on. A spawn description is roster metadata; it does not create a shared task. Then spawn one teammate per stream of concurrent work and tell each to claim from the board. When the user assigns named teammates specific responsibilities, preserve those assignments: create their tasks first, include each task id in the corresponding teammate's prompt, and instruct that teammate to read and claim that exact task using team_task_get and team_task_update. Use team_task_claim_next for work without a named assignment.

As a teammate, inspect the current board before acting. Read and claim an explicitly assigned task before performing it. If the Lead assigned a responsibility without a task record, create and claim one for that responsibility. If a task already names you as its owner and is in_progress, continue that task instead of claiming another. Only the Lead may spawn teammates or reassign tasks; send_message the Lead when work needs further delegation. After completing a task, send_message the Lead its result and verification evidence, then check for more work.

When you have no owned or explicitly assigned task, call team_task_claim_next to take work. It either hands you the task you now own or reports that there is nothing to take, and the reason says what to do next. no-ready-task means every remaining pending task is blocked by work still in progress, and write-scope-conflict means the remaining ready tasks would write where another member is already writing and lists them: in both cases inspect the blocking owner, use wait_agent only while it can progress, then claim again after a meaningful change. no-pending-task means no pending task remains, every task is completed or owned by another member, and nothing becomes claimable until the Lead creates a task or an owner releases one: end your turn with a short report of what you completed instead of waiting. No none result is a failure. Perform the claimed work, complete it with team_task_update, and immediately claim the next one. Release a task you cannot finish so another member can take it.

team_task_claim_next never returns a task another member owns and never gives the same task to two members, so every member may claim whenever it is free.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; keep them inside your claimed task's write scopes and have the Lead review the final diff and run tests.

Use send_message for quiet information that must not start an idle teammate. Use followup_task when the target should run another turn. A delivered peer item starts with its stable message id and sender name. A successful send is already durable even when its result says queued; do not resend it. Before wait_agent, read list_agents and the task board. A waiting member cannot produce progress; unrelated workspace conversations do not justify waiting. Wake a required inactive owner with followup_task. wait_agent returns noProgress immediately when no productive member remains, and refuses repeated short waits at a previously timed-out activity cursor. A longer wait for a verified running owner must at least double the previous expired duration and fit the remaining one-hour quiet budget; the result reports both bounds. Meaningful progress resets that budget. Inspect or repair stalled work after timeout or noProgress; do not repeat a wait or claim loop without a concrete change. Never mark unresolved work complete. The Lead collects verified results until every required task is completed; recover stalled ownership or report the unresolved blocker when waiting cannot help, then give the final answer only when the task outcome is established. A teammate ends its turn once no pending task remains, so wake it with followup_task when you create more tasks afterwards, and release or reassign a task whose owner is inactive, because it will not complete on its own.`

/**
 * Select the guidance one deployment's members receive.
 * @param coordination - the deployment's work-distribution mode.
 * @returns the policy text for that mode.
 */
function policyText(coordination: TeamCoordination): string {
  switch (coordination) {
    case 'delegated': return DELEGATED_POLICY
    case 'swarm': return SWARM_POLICY
    default: return assertNever(coordination, 'team coordination mode')
  }
}

/**
 * One roster row, matching `TeamMemberView`. The Lead pseudo-row omits the
 * teammate-only provisioning fields, so only identity, role, status, and
 * diagnostics are required.
 */
const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    title: { type: 'string' },
    role: { type: 'string', required: true, enum: ['lead', 'teammate', 'peer'] },
    status: { type: 'string', required: true, enum: ['running', 'waiting', 'idle', 'inactive', 'provisioning', 'failed'] },
    description: { type: 'string' },
    provider: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    model: { type: 'string' },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** One shared task, matching the public `TeamTaskView`. */
const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    ownerName: { type: 'string' },
    blockedBy: { type: 'array', required: true, items: { type: 'string' } },
    writeScopes: { type: 'array', required: true, items: { type: 'string' } },
    ready: { type: 'boolean', required: true },
    writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const SPAWN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    member: { ...MEMBER_VIEW_SCHEMA, required: true },
  },
} as const

const MEMBER_LIST_VALUE_SCHEMA = { type: 'array', items: MEMBER_VIEW_SCHEMA } as const

const SEND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['accepted', 'queued'] },
  },
} as const

/** Wait outcome, including the reason no peer can produce activity. */
const WAIT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timedOut: { type: 'boolean', required: true },
    cursor: { type: 'string', required: true },
    noProgress: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', required: true, enum: ['no-active-peer', 'unchanged-progress'] },
        message: { type: 'string', required: true },
        minimumTimeoutMs: { type: 'integer' },
        remainingTimeoutMs: { type: 'integer' },
      },
    },
  },
} as const

const INTERRUPT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    previousStatus: { type: 'string', required: true, enum: ['running', 'idle', 'inactive'] },
  },
} as const

const TASK_LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA },
    nextCursor: { type: 'integer' },
  },
} as const

/** An owned task, or the ordinary board state that left nothing to take. */
const CLAIM_NEXT_VALUE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        outcome: { type: 'string', required: true, const: 'claimed' },
        task: { ...TASK_VIEW_SCHEMA, required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        outcome: { type: 'string', required: true, const: 'none' },
        reason: { type: 'string', required: true, enum: ['no-pending-task', 'no-ready-task', 'write-scope-conflict'] },
        deferred: { type: 'array', required: true, items: { type: 'string' } },
      },
    },
  ],
} as const

/**
 * Declare one canonical output schema with compact model-facing JSON. Every
 * Team result is a fixed record, so the declared schema is what makes the
 * compiler check `execute` against the value the model is promised.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Register the complete Team tool set in one exact Agent scope. */
function install(agent: Agent, ctx: Context, config: Config & { coordination: TeamCoordination }): () => void {
  const scoped = agent.ctx
  const policy = policyText(config.coordination)
  const disposers: Array<() => unknown> = []
  const register = (disposer: () => unknown): void => { disposers.push(disposer) }
  try {
    if (config.coordination === 'swarm') register(installSwarmCommand(agent))
    register(scoped.systemPrompt.section({
      name: 'team:policy',
      order: FIRST_PARTY_SECTION_ORDER.TEAM_POLICY,
      text: () => {
        const membership = ctx.agentTeams.membership(agent)
        return `${policy}\n\nYour Team role is ${membership.role}; your Team name is ${membership.name}; Team id is ${membership.id}.\n\nUse list_agents for the current roster and registered workspace conversations. Read current tasks with team_task_list and complete details with team_task_get; pass a workspace peer's exact id as session_id to read its board. Read every returned page using nextCursor when present. Completed tasks retain their full details in these tools. Independent workspace conversations have session-qualified names. Use their exact names with send_message or followup_task to coordinate shared files and responsibilities. Each conversation owns its task board; agree on disjoint work before editing. Maintain task descriptions, ownership, dependencies, and write scopes with the Team tools as work changes. Pass handoffs directly to the responsible agent with the relevant task and session context. Do not ask the user to copy task ids, assign owners, or enter file scopes for agent coordination.`
      },
    }))

    register(scoped.tools.register(defineTool({
      name: 'spawn_teammate',
      description: 'Create one named, durable teammate. Only the Team Lead may call this tool.',
      parameters: {
        name: { type: 'string', required: true, description: 'Unique lower-kebab-case teammate name.' },
        description: { type: 'string', required: true, description: 'Short description of the delegated responsibility.' },
        prompt: { type: 'string', required: true, description: 'Complete initial task for the teammate.' },
        context: {
          type: 'string',
          enum: ['fresh', 'fork'],
          description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
        },
      },
      output: jsonOutput(SPAWN_VALUE_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'spawn_teammate')
        const context = args.context ?? 'fresh'
        const provider = context === 'fork' ? config.forkProvider : config.freshProvider
        return await ctx.agentTeams.spawnTeammate(agent, {
          name: args.name,
          description: args.description,
          prompt: [{ type: 'text', text: args.prompt }],
          context,
          ...provider === undefined ? {} : { provider },
          signal: exec.signal,
        })
      },
    })))

    const messageTool = (toolName: 'send_message' | 'followup_task', delivery: 'quiet' | 'wakeup'): void => {
      register(scoped.tools.register(defineTool({
        name: toolName,
        description: delivery === 'quiet'
          ? 'Send durable information to another Team member without starting an idle member.'
          : 'Send a durable follow-up task to another Team member and start a turn when needed.',
        parameters: {
          target: { type: 'string', required: true, description: 'Exact name from list_agents, including session-qualified workspace peers, or lead.' },
          message: { type: 'string', required: true, description: 'Self-contained message for the target.' },
        },
        output: jsonOutput(SEND_VALUE_SCHEMA),
        execute(args, exec) {
          return ctx.agentTeams.sendMessage(callingAgent(exec.agent, toolName), {
            target: args.target,
            content: [{ type: 'text', text: args.message }],
            delivery,
            signal: exec.signal,
          })
        },
      })))
    }
    messageTool('send_message', 'quiet')
    messageTool('followup_task', 'wakeup')

    register(scoped.tools.register(defineTool({
      name: 'list_agents',
      description: 'List the Lead, durable teammates, and live conversation leads in the same registered workspace with current runtime status and message targets.',
      parameters: {},
      output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        return Promise.resolve(ctx.agentTeams.listMembers(callingAgent(exec.agent, 'list_agents')))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'wait_agent',
      description: 'Wait for meaningful progress on Team work. Waiting members and unrelated workspace conversations cannot satisfy admission. Returns an activity cursor and noProgress when no productive member exists or an unchanged-cursor wait fails the bounded extension rule: at least twice the prior expired duration, within one hour cumulative quiet waiting. Inspect and repair stalled work instead of repeating that wait. This never wakes members or declares their work complete.',
      parameters: {
        timeout_ms: {
          type: 'integer',
          description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.',
        },
      },
      output: jsonOutput(WAIT_VALUE_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'wait_agent')
        const timeoutMs = args.timeout_ms ?? 30_000
        return await ctx.agentTeams.waitForProgress(caller, timeoutMs, exec.signal)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'interrupt_agent',
      description: 'Interrupt one teammate\'s current turn while preserving its pending inbox. Team Lead only.',
      parameters: {
        target: { type: 'string', required: true, description: 'Teammate name.' },
      },
      output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
      async execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.interrupt(
          callingAgent(exec.agent, 'interrupt_agent'),
          args.target,
        ))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_create',
      directWorkspaceEffect: 'none',
      description: 'Create one unowned pending task on the shared Team task board.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise task title.' },
        description: { type: 'string', required: true, description: 'Complete task details and acceptance criteria.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
        write_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Advisory workspace-relative file or directory prefixes this task expects to modify.',
        },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.createTask(callingAgent(exec.agent, 'team_task_create'), {
          subject: args.subject,
          description: args.description,
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_list',
      description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
      parameters: {
        session_id: { type: 'string', description: 'Optional exact workspace peer id from list_agents; omitted for your own Team board.' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'Optional exact status filter.',
        },
        owner: { type: 'string', description: 'Optional member-name filter; use unowned for tasks without an owner.' },
        ready: { type: 'boolean', description: 'Optional readiness filter.' },
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
      },
      output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
      isConcurrencySafe: () => true,
      execute(args, exec) {
        const status = args.status
        const filtered = ctx.agentTeams.listTasks(callingAgent(exec.agent, 'team_task_list'), args.session_id).filter(task =>
          (status === undefined || task.status === status)
          && (args.owner === undefined || (args.owner === 'unowned' ? task.ownerName === undefined : task.ownerName === args.owner))
          && (args.ready === undefined || task.ready === args.ready))
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? 50
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
        return Promise.resolve({
          tasks: filtered.slice(cursor, cursor + limit),
          ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_get',
      description: 'Read the complete latest value of one shared task before changing or executing it.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
        session_id: { type: 'string', description: 'Optional exact workspace peer id from list_agents; omitted for your own Team board.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.getTask(
          callingAgent(exec.agent, 'team_task_get'),
          TeamTaskId(args.task_id),
          args.session_id,
        ))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_claim_next',
      directWorkspaceEffect: 'none',
      description: 'Take ownership of the next ready task on the shared board: the first unblocked pending task whose write scopes no in-progress task is already writing. Returns outcome claimed with the task you now own, or outcome none with a reason: no-pending-task when no pending task remains, so nothing becomes claimable until a task is created, released, or reopened; no-ready-task when every pending task is blocked by work still in progress; write-scope-conflict, plus the deferred task ids, when the ready work would write where work in progress already writes. No none result is a failure. Two members can never claim the same task.',
      parameters: {},
      output: jsonOutput(CLAIM_NEXT_VALUE_SCHEMA),
      async execute(_args, exec) {
        return await ctx.agentTeams.claimNextReadyTask(callingAgent(exec.agent, 'team_task_claim_next'))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_update',
      directWorkspaceEffect: 'none',
      description: 'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list. claim, reassign, and a scope-widening edit are refused when the write scopes overlap a task already in progress.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision used as the CAS precondition.' },
        action: {
          type: 'string',
          required: true,
          enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'],
          description: 'Task transition to apply.',
        },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details for edit.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement write scopes for edit.' },
        owner: { type: 'string', description: 'Member name for Lead-only reassign; omit to unassign.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.updateTask(callingAgent(exec.agent, 'team_task_update'), {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: args.expected_revision,
          action: args.action,
          ...args.subject === undefined ? {} : { subject: args.subject },
          ...args.description === undefined ? {} : { description: args.description },
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
          ...args.owner === undefined ? {} : { owner: args.owner },
        })
      },
    })))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/** Install Team tools in every live or subsequently published Team member scope. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = {
    ...(config.freshProvider === undefined ? {} : { freshProvider: config.freshProvider }),
    ...(config.forkProvider === undefined ? {} : { forkProvider: config.forkProvider }),
    coordination: config.coordination ?? 'delegated',
    excludePresets: config.excludePresets ?? [],
  }
  const excludedPresets = new Set(resolved.excludePresets)
  const keepsPresetToolSet = (agent: Agent): boolean => {
    const preset = agent.session.header.agentPreset
    return preset !== undefined && excludedPresets.has(preset)
  }
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || keepsPresetToolSet(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return
    installed.set(agent, install(agent, ctx, resolved))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-team.scopedTools()')
}
