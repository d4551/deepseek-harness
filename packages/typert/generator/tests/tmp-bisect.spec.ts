/**
 * Temporary bisect leg: name the package whose host typert generation fails.
 * Deleted once the failing package is identified.
 */
import { describe, expect, it } from 'vitest'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'

const packages = [
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-settings-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-session-reference',
  '@deepseek-ai/dsh-experimental-agent-team',
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-message-feedback',
  '@deepseek-ai/dsh-goal',
  '@deepseek-ai/dsh-plugin-inventory',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-subagent',
]

describe('temporary typert bisect', () => {
  for (const name of packages) {
    it(`generates ${name}`, () => {
      const generator = new WorkspaceTypertGenerator(process.cwd(), { checkDiagnostics: false })
      expect(generator.generate([name], ['host'])).resolves.toBeTruthy()
    })
  }
})
