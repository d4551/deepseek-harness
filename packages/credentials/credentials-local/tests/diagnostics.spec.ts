import { describe, expect, it } from 'vitest'
import { parseCredentialsDocument } from '../src/index.ts'

const secret = 'sk-sensitive-diagnostic-value'

describe('credential document diagnostics', () => {
  it.each([
    ['version scalar', `version: ${secret}\n`],
    ['version sequence', `version: [${secret}]\n`],
    ['version mapping', `version: {token: ${secret}}\n`],
    ['record kind scalar', `version: 1\nrecords:\n  llm-provider/account:\n    kind: ${secret}\n`],
    ['record kind sequence', `version: 1\nrecords:\n  llm-provider/account:\n    kind: [${secret}]\n`],
    ['record kind mapping', `version: 1\nrecords:\n  llm-provider/account:\n    kind: {token: ${secret}}\n`],
  ])('rejects %s without exposing its value', (_name, text) => {
    const parse = () => parseCredentialsDocument(text, 'credentials.yaml')
    expect(parse).toThrow(/credentials-local:/)
    const safeDiagnostic: unknown = expect.not.stringContaining(secret)
    expect(parse).toThrow(expect.objectContaining({
      message: safeDiagnostic,
      stack: safeDiagnostic,
    }))
  })
})
