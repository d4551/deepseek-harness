import { describe, expect, it } from 'vitest'
import { lineSpans } from '../src/markdown/highlight-spans.ts'

describe('streaming token spans', () => {
  it('retains tokens with optional font style absent and emits every TextMate decoration', () => {
    expect(lineSpans([
      { content: 'plain', offset: 0, color: 'var(--shiki-foreground)' },
      { content: 'styled', offset: 5, color: 'var(--shiki-token-keyword)', fontStyle: 1 | 2 | 4 | 8 },
    ])).toEqual([
      { text: 'plain', style: { color: 'var(--shiki-foreground)' } },
      { text: 'styled', style: {
        color: 'var(--shiki-token-keyword)', fontStyle: 'italic', fontWeight: 'bold',
        textDecoration: 'underline line-through',
      } },
    ])
  })

  it('preserves all whitespace while folding interior runs into the next styled token', () => {
    expect(lineSpans([
      { content: ' ', offset: 0 },
      { content: '\t', offset: 1 },
      { content: 'name', offset: 2, color: 'var(--shiki-token-function)' },
      { content: '  ', offset: 6 },
    ])).toEqual([
      { text: ' \tname', style: { color: 'var(--shiki-token-function)' } },
      { text: '  ', style: { color: undefined } },
    ])
    expect(lineSpans([])).toEqual([])
  })
})
