import { describe, expect, it } from 'vitest'
import { extractMarkdownPlainText } from '@deepseek-ai/dsh-client-ui-primitives'

const MARKDOWN = [
  '# Release notes',
  '',
  'First **paragraph** with [a link](https://example.com) and ![diagram](diagram.png).',
  '',
  '- shipped',
  '- `verified`',
  '',
  '```ts',
  'const ready = true',
  '```',
].join('\n')

describe('extractMarkdownPlainText', () => {
  it('projects the complete GFM document without presentation syntax', () => {
    expect(extractMarkdownPlainText(MARKDOWN)).toBe([
      'Release notes',
      '',
      'First paragraph with a link and diagram.',
      '',
      'shipped',
      'verified',
      '',
      'const ready = true',
    ].join('\n'))
  })

  it('selects the first visible line or first semantic paragraph', () => {
    expect(extractMarkdownPlainText(MARKDOWN, { mode: 'first-line' })).toBe('Release notes')
    expect(extractMarkdownPlainText(MARKDOWN, { mode: 'first-paragraph' }))
      .toBe('First paragraph with a link and diagram.')
  })

  it('preserves raw HTML while removing Markdown presentation markup', () => {
    const block = [
      '<background-job-complete id="trajectory-ui-watch">',
      'Command: pnpm test',
      'Exit code: 0',
      '</background-job-complete>',
    ].join('\n')
    expect(extractMarkdownPlainText(block)).toBe(block)
    expect(extractMarkdownPlainText('**Status:** <span data-state="ok">ready</span>'))
      .toBe('Status: <span data-state="ok">ready</span>')
    expect(extractMarkdownPlainText(block, { mode: 'first-paragraph' }))
      .toBe('<background-job-complete id="trajectory-ui-watch">')
  })

  it('projects GFM tables, references, hard breaks, and block structure', () => {
    const markdown = [
      '> first\\',
      '> second with ![diagram][asset] and <span>visible</span>',
      '',
      '---',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| alpha | `1` |',
      '',
      '[asset]: diagram.png',
    ].join('\n')
    expect(extractMarkdownPlainText(markdown)).toBe([
      'first second with diagram and <span>visible</span>',
      '',
      'Name\tValue',
      'alpha\t1',
    ].join('\n'))
  })

  it.each(['', ' \n\t\n', '---', '[label]: /target', '```\n```', '![](image.png)'])(
    'returns empty text for a document without visible content: %j',
    (markdown) => {
      expect(extractMarkdownPlainText(markdown)).toBe('')
      expect(extractMarkdownPlainText(markdown, { mode: 'first-line' })).toBe('')
      expect(extractMarkdownPlainText(markdown, { mode: 'first-paragraph' })).toBe('')
    },
  )

  it('finds the first nonempty paragraph inside nested blocks', () => {
    const markdown = [
      '# Heading',
      '',
      '![](image.png)',
      '',
      '> ---',
      '>',
      '> - **First** nested paragraph',
      '>',
      '>   Second nested paragraph',
      '',
      'Final paragraph',
    ].join('\n')
    expect(extractMarkdownPlainText(markdown, { mode: 'first-paragraph' }))
      .toBe('First nested paragraph')
    expect(extractMarkdownPlainText(markdown)).toBe([
      'Heading',
      '',
      'First nested paragraph Second nested paragraph',
      '',
      'Final paragraph',
    ].join('\n'))
  })

  it('selects a visible line when the document has no paragraph', () => {
    const markdown = '\n---\n\n```\n\n  first\n\n\n\n  second\n\n```'
    expect(extractMarkdownPlainText(markdown, { mode: 'all' })).toBe('first\n\nsecond')
    expect(extractMarkdownPlainText(markdown, { mode: 'first-line' })).toBe('first')
    expect(extractMarkdownPlainText(markdown, { mode: 'first-paragraph' })).toBe('first')
  })

  it('keeps the complete line when the document has no newline', () => {
    expect(extractMarkdownPlainText('# Title', { mode: 'first-line' })).toBe('Title')
    expect(extractMarkdownPlainText('# Title', { mode: 'first-paragraph' })).toBe('Title')
    expect(extractMarkdownPlainText('Text', { mode: 'first-line' })).toBe('Text')
  })

  it('preserves nested inline labels and decodes character references', () => {
    const markdown = '***Strong emphasis*** ~~removed~~ [**label**][link] &amp; `a  b` ![][image]\n\n'
      + '[link]: https://example.com\n[image]: image.png'
    expect(extractMarkdownPlainText(markdown)).toBe('Strong emphasis removed label & a b')
  })

  it('preserves footnote paragraph and code boundaries', () => {
    const markdown = [
      'Read this[^note].',
      '',
      '[^note]: First **note** paragraph.',
      '',
      '    Second paragraph.',
      '',
      '    ```ts',
      '    const note = true',
      '    ```',
    ].join('\n')
    expect(extractMarkdownPlainText(markdown)).toBe([
      'Read this.',
      '',
      'First note paragraph.',
      '',
      'Second paragraph.',
      '',
      'const note = true',
    ].join('\n'))
  })

  it.each([
    ['> first\n>\n> second', 'first\n\nsecond'],
    ['# one   two', 'one two'],
    ['| first   cell | `  second  ` |\n| --- | --- |', 'first cell\tsecond'],
    ['| | |\n| --- | --- |\n| first | second |\n| | |', 'first\tsecond'],
    ['**one *two* three**', 'one two three'],
    ['- first\n-\n- last', 'first\nlast'],
    ['- first\n\n  ![](image.png)\n\n  last', 'first last'],
    ['- first\n\n  ```\n    code\n  ```\n\n  last', 'first code last'],
    ['<div>\n\n', '<div>'],
    ['- `  first  `\n\n  `  last  `', 'first last'],
    ['- first\n\n  > ---\n  >\n  > second\n\n  third', 'first second third'],
  ])('preserves readable spacing in %j', (markdown, expected) => {
    expect(extractMarkdownPlainText(markdown)).toBe(expected)
  })
})
