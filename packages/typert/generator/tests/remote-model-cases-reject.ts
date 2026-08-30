/**
 * Shared Remote-model rejection case bodies and the method-shape rejection
 * table. Registered by remote-model.spec.ts; the split remote-model-*.spec.ts
 * files register the same functions.
 */

import { expect } from 'vitest'
import {
  analyzeRemote,
  copyFixture,
  editFile,
} from './remote-model-helpers.ts'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'

export function rejectsUntransportableAlias(alias: string): void {
  const root = copyFixture()
  editFile(root, 'packages/remote/src/index.ts', source => source.replace(
    '  @Remote\n  async create(',
    `  @Remote('${alias}')\n  async create(`,
  ))

  expect(() => new WorkspaceTypertGenerator(root).generate()).toThrow(/RPC endpoint segment characters/)
}

export function rejectsRemoteExportWithoutMethods(): void {
  const root = copyFixture()
  editFile(root, 'packages/remote/src/index.ts', source => source
    .replaceAll('  @Remote\n', '')
    .replace("  @RemoteScope('agent')\n", '')
    .replace("  @Remote({ mode: 'stream' })\n", ''))
  editFile(root, 'packages/remote/src/types.ts', source => `${source}

/** @typert schema */
export interface RemainingSchema {
  readonly value: string
}
`)

  expect(() => new WorkspaceTypertGenerator(root).generate())
    .toThrow('publishes Remote artifacts but has no Remote methods')
}

export interface MethodShapeRejection {
  readonly name: string
  readonly edit: (source: string) => string
  readonly message: string
}

export const methodShapeRejections: readonly MethodShapeRejection[] = [
  {
    name: 'missing binding',
    edit: (source: string) => source.replace(
      "export class GoalService extends TypertRemoteService {\n  constructor() {\n    super(undefined, 'goals')\n  }",
      'export class GoalService {',
    ),
    message: 'Remote methods require TypertRemoteService',
  },
  {
    name: 'dynamic TypertRemoteService key',
    edit: (source: string) => source.replace(
      "  constructor() {\n    super(undefined, 'goals')\n  }",
      '  constructor(serviceKey: string) {\n    super(undefined, serviceKey)\n  }',
    ),
    message: 'Gateway service key must be a string literal',
  },
  {
    name: 'TypertRemoteService without a constructor',
    edit: (source: string) => source.replace(
      "  constructor() {\n    super(undefined, 'goals')\n  }\n\n",
      '',
    ),
    message: 'TypertRemoteService subclasses must declare a constructor',
  },
  {
    name: 'TypertRemoteService without a direct super call',
    edit: (source: string) => source.replace(
      "    super(undefined, 'goals')",
      '    undefined',
    ),
    message: 'TypertRemoteService constructor must call super',
  },
  {
    name: 'TypertRemoteService super call without a service key',
    edit: (source: string) => source.replace(
      "    super(undefined, 'goals')",
      '    super(undefined)',
    ),
    message: 'TypertRemoteService super\\(\\) requires context, service key',
  },
  {
    name: 'duplicate TypertRemoteService field binding',
    edit: (source: string) => source
      .replace(
        'import { TypertRemoteService, Remote, RemoteScope }',
        'import { TypertRemoteService, Remote, RemoteScope, bindTypertRemote }',
      )
      .replace(
        'export class GoalService extends TypertRemoteService {',
        "export class GoalService extends TypertRemoteService {\n  readonly typertRemote = bindTypertRemote(this, 'goals')",
      ),
    message: 'TypertRemoteService subclasses must not declare a second typertRemote binding',
  },
  {
    name: 'private method',
    edit: (source: string) => source.replace('  async create(', '  private async create('),
    message: 'Remote decorators require a public instance method',
  },
  {
    name: 'static method',
    edit: (source: string) => source.replace('  async create(', '  static async create('),
    message: 'Remote decorators require a public instance method',
  },
  {
    name: 'abstract method',
    edit: (source: string) => source
      .replace('export class GoalService', 'export abstract class GoalService')
      .replace(
        '  async create(agent: Agent, request: CreateGoalRequest, signal: AbortSignal): Promise<CreateGoalResult> {\n    signal.throwIfAborted()\n    return { ref: `${agent.id}:${request.title}` }\n  }',
        '  abstract create(agent: Agent, request: CreateGoalRequest, signal: AbortSignal): Promise<CreateGoalResult>',
      ),
    message: 'Remote methods must have a concrete implementation',
  },
  {
    name: 'generic method',
    edit: (source: string) => source.replace('  async create(', '  async create<Value>('),
    message: 'generic Remote methods are not supported',
  },
  {
    name: 'destructured parameter',
    edit: (source: string) => source.replace('request: CreateGoalRequest', '{ title }: CreateGoalRequest'),
    message: 'Remote parameters must use identifier bindings',
  },
  {
    name: 'rest parameter',
    edit: (source: string) => source.replace('request: CreateGoalRequest', '...request: [CreateGoalRequest]'),
    message: 'Remote parameters cannot be rest parameters',
  },
  {
    name: 'default parameter',
    edit: (source: string) => source.replace(
      'request: CreateGoalRequest',
      "request: CreateGoalRequest = { title: '' }",
    ),
    message: 'Remote parameters cannot have default values',
  },
  {
    name: 'optional lookup parameter',
    edit: (source: string) => source.replace('agent: Agent,', 'agent?: Agent,'),
    message: 'lookup parameter for agent cannot be optional',
  },
  {
    name: 'wrong cancellation type',
    edit: (source: string) => source.replace('signal: AbortSignal', 'signal: string'),
    message: 'cancellation must use a parameter named signal with the global AbortSignal type',
  },
  {
    name: 'wrong cancellation name',
    edit: (source: string) => source.replace('signal: AbortSignal', 'abort: AbortSignal'),
    message: 'cancellation must use a parameter named signal with the global AbortSignal type',
  },
  {
    name: 'non-final cancellation',
    edit: (source: string) => source.replace(
      'agent: Agent, request: CreateGoalRequest, signal: AbortSignal',
      'agent: Agent, signal: AbortSignal, request: CreateGoalRequest',
    ),
    message: 'cancellation signal must be the final parameter',
  },
]

export function rejectsMethodShape(edit: (source: string) => string, message: string): void {
  const root = copyFixture()
  editFile(root, 'packages/remote/src/index.ts', edit)

  expect(() => analyzeRemote(root, false)).toThrow(new RegExp(message))
}

export function rejectsWorkspaceClassWithoutLookup(): void {
  const root = copyFixture()
  editFile(root, 'packages/domain/src/index.ts', source => source.replace(
    '  interface TypertLookupMap {\n    agent: TypertLookup<Agent, AgentId>\n  }\n\n',
    '',
  ))

  expect(() => analyzeRemote(root, false)).toThrow(/non-JSON class parameter Agent requires a TypertLookupMap entry/)
}

export function rejectsNonJsonBoundary(type: string, message: string): void {
  const root = copyFixture()
  editFile(root, 'packages/remote/src/types.ts', source => source.replace(
    '  readonly title: string\n}',
    `  readonly title: string\n  readonly invalid: ${type}\n}`,
  ))

  expect(() => analyzeRemote(root, false)).toThrow(new RegExp(message))
}

export function keepsOptionalJsonFieldsValid(): void {
  const root = copyFixture()
  editFile(root, 'packages/remote/src/types.ts', source => source.replace(
    '  readonly title: string\n}',
    '  readonly title: string\n  readonly note?: string\n}',
  ))

  expect(() => analyzeRemote(root)).not.toThrow()
}

export function rejectsScopeWithoutContext(): void {
  const root = copyFixture()
  editFile(root, 'packages/remote/src/index.ts', source => source.replace("@RemoteScope('agent')", "@RemoteScope('missing')"))

  expect(() => analyzeRemote(root, false)).toThrow(/Remote Scope missing has no TypertContextMap entry/)
}

export function rejectsScopedWireMismatch(): void {
  const root = copyFixture()
  editFile(root, 'packages/domain/src/types.ts', source => `${source}\n/** Deliberately distinct Context identity for the failure fixture. */\nexport type OtherAgentId = string\n`)
  editFile(root, 'packages/domain/src/index.ts', source => source
    .replace("import type { AgentId } from './types.ts'", "import type { AgentId, OtherAgentId } from './types.ts'")
    .replace('agent: TypertContext<AgentId>', 'agent: TypertContext<OtherAgentId>'))

  expect(() => analyzeRemote(root, false)).toThrow(/Remote scope agent wire type .* does not match lookup wire type/)
}

export function rejectsDuplicateEndpoints(): void {
  const root = copyFixture()
  editFile(root, 'packages/remote/src/index.ts', source => `${source}
export class DuplicateGoalService extends TypertRemoteService {
  constructor() {
    super(undefined, 'duplicate', { namespace: 'goals' })
  }

  @Remote
  create(request: CreateGoalRequest): CreateGoalResult {
    return { ref: request.title }
  }
}
`)

  expect(() => analyzeRemote(root, false)).toThrow(/Remote endpoint goals\/create conflicts/)
}
