import { afterEach, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { page } from 'vitest/browser'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { MarkdownText } from '../src/markdown/MarkdownText.tsx'
import { markdownLabels } from './labels.client.ts'

afterEach(() => {
  cleanup()
  document.body.removeAttribute('data-ds-dark-theme')
})

it.each([
  { theme: 'light', surface: 'code' },
  { theme: 'dark', surface: 'code' },
  { theme: 'light', surface: 'markdown' },
  { theme: 'dark', surface: 'markdown' },
])('preserves focus, selection, and scroll when $surface finishes in $theme mode', async ({ theme, surface }) => {
  if (theme === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
  await page.viewport(600, 400)
  const code = `const answer = "${'long code '.repeat(200)}"\nconst next = answer\n`
  const output = (streaming: boolean) => surface === 'markdown'
    ? <MarkdownText text={`Introduction\n\n\`\`\`ts\n${code}\`\`\`\n\nCompleted.`} streaming={streaming} labels={markdownLabels} />
    : <CodeBlock code={code} lang="ts" streaming={streaming} {...markdownLabels.code} />
  const view = render(output(true))
  const pre = view.container.querySelector('pre')
  const token = pre?.querySelector('.line span')?.firstChild
  const selection = window.getSelection()
  if (pre === null || token === undefined || token === null || selection === null) {
    throw new Error('Highlighted code must expose selectable text')
  }
  pre.focus()
  const range = document.createRange()
  range.selectNodeContents(token)
  selection.removeAllRanges()
  selection.addRange(range)
  const selected = selection.toString()
  expect(selected).toBe('const')
  window.scrollTo(0, 40)
  expect(window.scrollY).toBe(40)

  act(() => { view.rerender(output(false)) })

  expect(document.activeElement).toBe(pre)
  expect(window.scrollY).toBe(40)
  expect(selection.toString()).toBe(selected)
  expect(view.container.querySelector('pre')?.textContent).toBe(code.slice(0, -1))
  const audit = await auditSurface('completed code', view.container)
  expect(audit.incomplete).toEqual([])
  expect(accessibilityFailures([audit], 100)).toBe('')
})
