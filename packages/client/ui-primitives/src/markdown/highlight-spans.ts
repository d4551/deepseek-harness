import type { ThemedToken } from 'shiki/core'
import type { CSSProperties } from 'react'
import type { HighlightSpan } from './highlight.ts'

/** TextMate decoration bits rendered by Shiki's HTML arm. */
const DECORATION_BITS: readonly (readonly [number, string])[] = [[4, 'underline'], [8, 'line-through']]

function spanStyle(token: ThemedToken): CSSProperties {
  const style: CSSProperties = { color: token.color }
  const bits = token.fontStyle ?? 0
  if ((bits & 1) !== 0) style.fontStyle = 'italic'
  if ((bits & 2) !== 0) style.fontWeight = 'bold'
  const decorations = DECORATION_BITS.filter(([bit]) => (bits & bit) !== 0)
  if (decorations.length > 0) style.textDecoration = decorations.map(([, value]) => value).join(' ')
  return style
}

/** Match Shiki's whitespace folding and token styles for streaming line spans. */
export function lineSpans(line: ThemedToken[]): HighlightSpan[] {
  const spans: HighlightSpan[] = []
  let pendingWhitespace = ''
  for (const [index, token] of line.entries()) {
    if (/^\s+$/.test(token.content) && index + 1 < line.length) {
      pendingWhitespace += token.content
      continue
    }
    spans.push({ text: pendingWhitespace + token.content, style: spanStyle(token) })
    pendingWhitespace = ''
  }
  return spans
}
