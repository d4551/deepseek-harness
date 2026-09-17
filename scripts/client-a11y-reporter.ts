/** Join source audit obligations to native per-test browser execution. */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Reporter, TestCase, TestModule, TestSpecification, Vitest } from 'vitest/node'
import type {} from '../packages/test-support/client-a11y/tests/task-meta.d.ts'
import { accessibilityTestDefinitions, type AccessibilityTestDefinition } from './client-a11y-candidates.ts'
import { clientAccessibilityCandidates } from './client-a11y-coverage.ts'

/** Native Vitest reporter enforcing each selected accessibility test's own receipts. */
export default class ClientAccessibilityReporter implements Reporter {
  private context: Vitest | undefined
  private requirements = new Map<string, AccessibilityTestDefinition[]>()
  private complete = false

  /**
   * Retain the runner's canonical root and explicit test-name selection.
   * @param context - native runner owning this report.
   */
  onInit(context: Vitest): void {
    this.context = context
  }

  /**
   * Capture source obligations before tests execute.
   * @param specifications - actual selected test modules from Vitest.
   * @returns completion of configured discovery and obligation checks.
   */
  async onTestRunStart(specifications: readonly TestSpecification[]): Promise<void> {
    const context = this.requireContext()
    const candidates = clientAccessibilityCandidates(join(context.config.root, 'packages/client'))
    const selected = new Set(specifications.map(specification => resolve(specification.moduleId)))
    this.requirements = new Map()
    const all = [...candidates.values()].flat()
    const configured = new Set((await context.globTestSpecifications()).map(specification => resolve(specification.moduleId)))
    const { config } = context
    const selectedProjects = config.cliOptions.project !== undefined
    const excludedByInvocation = config.cliOptions.cliExclude !== undefined
    if (!selectedProjects && !excludedByInvocation) {
      for (const file of all) {
        if (!configured.has(resolve(file))) throw new Error(`Required accessibility candidate is absent from configured discovery: ${file}`)
      }
    }
    const focused = selectedProjects || excludedByInvocation || config.testNamePattern !== undefined
      || config.shard !== undefined || config.related !== undefined || Boolean(config.changed)
      || config.tagsFilter !== undefined || ![...configured].every(file => selected.has(file))
    this.complete = !focused && all.every(file => selected.has(resolve(file)))
    if (this.complete) {
      const missing = [...candidates].filter(([, files]) => files.length === 0).map(([name]) => name)
      if (missing.length > 0) throw new Error(`Accessibility packages have no audit candidates: ${missing.join(', ')}`)
    }
    for (const file of all) {
      if (!selected.has(resolve(file))) continue
      const definitions = accessibilityTestDefinitions(file, readFileSync(file, 'utf8'))
      if (definitions.length === 0) throw new Error(`Accessibility candidate has no attributable test definition: ${file}`)
      this.requirements.set(resolve(file), definitions)
    }
  }

  /**
   * Require real passing audit evidence from every selected obligated test.
   * @param modules - native modules and test outcomes from this execution.
   */
  onTestRunEnd(modules: readonly TestModule[]): void {
    const context = this.requireContext()
    const failures: string[] = []
    let verified = 0
    for (const [file, definitions] of this.requirements) {
      const module = modules.find(value => resolve(value.moduleId) === file)
      if (module === undefined) {
        failures.push(`${file}: required browser module did not execute`)
        continue
      }
      for (const definition of definitions) {
        const tests = [...module.children.allTests()].filter(test => matchesDefinition(test, definition))
        if (tests.length === 0 && context.config.testNamePattern === undefined) {
          failures.push(`${file}:${definition.startLine}: required audit test was not registered with a native location`)
        }
        for (const test of tests) {
          if (context.config.testNamePattern !== undefined && !context.config.testNamePattern.test(test.fullName)) continue
          const surfaces = test.meta().accessibilitySurfaces
          if (test.result().state !== 'passed' || surfaces === undefined || surfaces.length === 0) {
            failures.push(`${file}:${definition.startLine}: ${test.fullName} has no passing native 100-point audit receipt`)
          } else {
            verified += 1
          }
        }
      }
    }
    if (failures.length > 0) throw new Error(`Accessibility execution evidence failed:\n${failures.join('\n')}`)
    context.logger.log(`Accessibility execution: ${verified} test(s) verified; ${this.complete ? 'complete package candidate inventory' : 'focused selection, not complete package evidence'}.`)
  }

  private requireContext(): Vitest {
    if (this.context === undefined) throw new Error('Accessibility reporter has no native runner owner')
    return this.context
  }
}

function matchesDefinition(test: TestCase, definition: AccessibilityTestDefinition): boolean {
  const location = test.location
  return location !== undefined
    && (location.line > definition.startLine
      || (location.line === definition.startLine && location.column >= definition.startColumn))
    && (location.line < definition.endLine
      || (location.line === definition.endLine && location.column < definition.endColumn))
}
