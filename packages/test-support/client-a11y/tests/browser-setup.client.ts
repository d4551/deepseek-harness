import { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, onTestFinished, type RunnerTestCase } from 'vitest'
import { observeAccessibilityExecution, type SurfaceAudit } from '../src/index.ts'
import type {} from './task-meta.d.ts'
import { installThemeStyles } from '../../../client/ui-theme/src/client/styles.ts'
import './browser-page.css'

const context = new Context()
interface AuditExecution {
  owner: RunnerTestCase | undefined
  readonly validations: Set<AuditValidation>
}

interface AuditValidation {
  readonly owner: RunnerTestCase
  readonly audits: readonly SurfaceAudit[]
  readonly executions: readonly AuditExecution[]
}

const executions = new WeakMap<SurfaceAudit, AuditExecution>()

const stopRecording = observeAccessibilityExecution({
  started() {
    const execution: AuditExecution = { owner: undefined, validations: new Set() }
    onTestFinished(({ task }) => {
      execution.owner = task
      for (const validation of execution.validations) publishValidation(validation)
    })
    return (audit) => { executions.set(audit, execution) }
  },
  validated(audits) {
    const owned = audits.map((audit) => {
      const execution = executions.get(audit)
      if (execution === undefined) throw new Error('Accessibility result has no native execution owner')
      return execution
    })
    onTestFinished(({ task }) => {
      const validation = { owner: task, audits, executions: owned }
      for (const execution of owned) execution.validations.add(validation)
      publishValidation(validation)
    })
  },
})

function publishValidation(validation: AuditValidation): void {
  if (validation.executions.some(execution => execution.owner === undefined)) return
  for (const execution of validation.executions) {
    execution.validations.delete(validation)
    if (execution.owner !== validation.owner) {
      throw new Error('Accessibility results must be produced and validated by the same test')
    }
  }
  validation.owner.meta.accessibilitySurfaces ??= []
  validation.owner.meta.accessibilitySurfaces.push(...validation.audits.map(audit => audit.surface))
}

beforeAll(() => {
  installThemeStyles(context)
})

afterAll(async () => {
  try {
    await context.fiber.dispose()
  } finally {
    stopRecording()
  }
})
