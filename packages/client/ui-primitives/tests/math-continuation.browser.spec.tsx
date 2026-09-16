import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { MarkdownText } from '../src/markdown/MarkdownText.tsx'
import { markdownLabels } from './labels.client.ts'

afterEach(cleanup)

it('lets native character escapes determine which backslash runs open inline math', () => {
  for (let count = 0; count <= 12; count += 1) {
    const source = '\\'.repeat(count) + String.raw`(x\)`
    const view = render(<MarkdownText text={source} labels={markdownLabels} />)
    expect([...view.container.querySelectorAll('annotation')].map(node => node.textContent))
      .toEqual(count % 2 === 1 ? ['x'] : [])
    if (count % 2 === 0) {
      expect(view.container.textContent).toBe('\\'.repeat(count / 2) + '(x)')
    }
    expect(view.container.querySelector('.katex-error')).toBeNull()
    view.unmount()
  }
})

it('keeps multiline TeX inside its quote and list containers', async () => {
  const source = [
    '> \\[',
    '> a + b',
    '> \\]',
    '',
    '- \\[',
    '  c + d',
    '  \\]',
    '',
    '  After the formula.',
  ].join('\n')
  const { container } = render(<MarkdownText text={source} labels={markdownLabels} />)

  expect(container.querySelector('blockquote .katex-display annotation')?.textContent).toBe('a + b')
  expect(container.querySelector('li .katex-display annotation')?.textContent).toBe('c + d')
  expect(container.querySelector('li p')?.textContent).toBe('After the formula.')
  expect(container.querySelectorAll('.katex-display')).toHaveLength(2)
  expect(container.querySelector('.katex-error')).toBeNull()
  const audit = await auditSurface('multiline math containers', container)
  expect(audit.incomplete).toEqual([])
  expect(accessibilityFailures([audit], 100)).toBe('')
})

it('leaves lazy continuations and incomplete or escaped delimiters literal', async () => {
  const source = [
    '> \\[',
    'Outside the quote.',
    '\\]',
    '',
    String.raw`\\(escaped\)`,
    '',
    String.raw`\(unfinished`,
  ].join('\n')
  const { container } = render(<MarkdownText text={source} labels={markdownLabels} />)

  expect(container.querySelector('.katex')).toBeNull()
  expect(container.querySelector('blockquote')?.textContent).toBe('\n[\nOutside the quote.\n]\n')
  expect(container.textContent).toContain('\\(escaped)')
  expect(container.textContent).toContain('(unfinished')
  const audit = await auditSurface('literal math delimiters', container)
  expect(audit.incomplete).toEqual([])
  expect(accessibilityFailures([audit], 100)).toBe('')
})
