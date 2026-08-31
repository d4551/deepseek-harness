import { describe, expect, it } from 'vitest'
import { flattenDiagnosticMessage } from '../src/index.ts'

describe('flattenDiagnosticMessage', () => {
  it('returns an already-flat string unchanged', () => {
    expect(flattenDiagnosticMessage('plain', '\n')).toBe('plain')
  })

  it('returns the text alone when the chain is absent or empty', () => {
    expect(flattenDiagnosticMessage({ text: 'only' }, '\n')).toBe('only')
    expect(flattenDiagnosticMessage({ text: 'only', messageChain: [] }, '\n')).toBe('only')
  })

  it('joins a chain outermost first, separator between entries', () => {
    const message = { text: 'outer', messageChain: [{ text: 'inner' }, { text: 'sibling' }] }
    expect(flattenDiagnosticMessage(message, ' -> ')).toBe('outer -> inner -> sibling')
  })

  it('descends nested chains depth first', () => {
    const message = {
      text: 'a',
      messageChain: [{ text: 'b', messageChain: [{ text: 'c' }] }, { text: 'd' }],
    }
    expect(flattenDiagnosticMessage(message, '|')).toBe('a|b|c|d')
  })
})
