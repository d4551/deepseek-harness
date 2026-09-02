// Shared fixtures for the Plugins settings card specs: locale seat, settled
// card-shell state, field/candidate factories, card actions, and the render
// helpers shared across the model-selection card specs.

import { render } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AgentDefaultModelCard } from '../src/client/AgentDefaultModelCard.tsx'
import type { AgentDefaultModelCardProps } from '../src/client/AgentDefaultModelCard.tsx'
import type { AgentDefaultModelCardState } from '../src/client/agent-default-model-card-controller.ts'
import { SubagentModelSelectionCard } from '../src/client/SubagentModelSelectionCard.tsx'
import type { SubagentModelSelectionCardProps } from '../src/client/SubagentModelSelectionCard.tsx'
import type { SubagentModelSelectionCardState } from '../src/client/subagent-model-selection-card-controller.ts'
import type { ModelRouteCandidate } from '../src/client/model-route.ts'
import type { CardFieldState, CardShell } from '../src/client/card-form.ts'
import { en } from '../src/client/locales.ts'
import { cardProps } from './props.client.ts'

/** Locale stub over the English card copy, shaped as the framework `t` seat. */
export const t = makeTranslate(en)

export const settled: CardShell = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

export function field(text: string, rest: Partial<CardFieldState> = {}): CardFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

/** Typed card action stubs: signatures match the shared card action face. */
export function cardActions(): {
  edit: Mock<(field: string, text: string) => void>
  resetField: Mock<(field: string) => void>
  save: Mock<() => void>
  discard: Mock<() => void>
} {
  return {
    edit: vi.fn(),
    resetField: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  }
}

export function candidate(
  provider: string,
  model: string,
  rest: Partial<ModelRouteCandidate> = {},
): ModelRouteCandidate {
  return {
    key: `${provider}\0${model}`,
    provider,
    model,
    providerName: `${provider} API`,
    modelName: model,
    available: true,
    selected: false,
    ...rest,
  }
}

export function renderAgentDefaultModel(state: Partial<AgentDefaultModelCardState> = {}): {
  selectModel: ReturnType<typeof vi.fn>
  retryCatalog: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  discard: ReturnType<typeof vi.fn>
} {
  const store = createSnapshotStore<AgentDefaultModelCardState>({
    ...settled,
    candidates: [],
    catalogStatus: 'idle',
    catalogPartial: false,
    conflicted: false,
    ...state,
  })
  const actions = {
    selectModel: vi.fn(),
    retryCatalog: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  }
  const props = cardProps<AgentDefaultModelCardProps>({
    ...actions,
    t,
    useAgentDefaultModelCard: bindSnapshotSelector(store),
  })
  render(<main><ul>{<AgentDefaultModelCard {...props} />}</ul></main>)
  return actions
}

export function renderSubagentModelSelection(state: Partial<SubagentModelSelectionCardState> = {}): {
  toggleEnabled: ReturnType<typeof vi.fn>
  toggleModel: ReturnType<typeof vi.fn>
  retryCatalog: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  discard: ReturnType<typeof vi.fn>
} {
  const store = createSnapshotStore<SubagentModelSelectionCardState>({
    ...settled,
    enabled: false,
    candidates: [],
    catalogStatus: 'idle',
    catalogPartial: false,
    conflicted: false,
    ...state,
  })
  const actions = {
    toggleEnabled: vi.fn(),
    toggleModel: vi.fn(),
    retryCatalog: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  }
  const props = cardProps<SubagentModelSelectionCardProps>({
    ...actions,
    t,
    useSubagentModelSelectionCard: bindSnapshotSelector(store),
  })
  render(<main><ul>{<SubagentModelSelectionCard {...props} />}</ul></main>)
  return actions
}
