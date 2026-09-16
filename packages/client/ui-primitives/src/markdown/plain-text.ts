/**
 * Markdown-to-plain-text projection for compact summaries and labels.
 * Parsing shares the renderer's streaming GFM grammar ({@link parseGfm}), so
 * the projection strips exactly the markup the renderer would draw; raw HTML
 * stays literal, links keep their labels, images keep alt text, and code
 * keeps its source text.
 */

import type { Nodes } from 'mdast'
import { parseGfm } from './parse.ts'

/** Amount of parsed Markdown content returned by the extractor. */
export type MarkdownPlainTextMode = 'all' | 'first-line' | 'first-paragraph'

/** Options for {@link extractMarkdownPlainText}. */
export interface MarkdownPlainTextOptions {
  /** Projection boundary; defaults to the complete document. */
  mode?: MarkdownPlainTextMode
}

function compactInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function nodeText(node: Nodes): string {
  switch (node.type) {
    case 'root':
    case 'blockquote':
    case 'footnoteDefinition':
      return node.children.map(nodeText).filter(Boolean).join('\n\n')
    case 'paragraph':
    case 'heading':
    case 'tableCell':
      return compactInline(node.children.map(nodeText).join(''))
    case 'code':
      return node.value.trim()
    case 'list':
    case 'table':
      return node.children.map(nodeText).filter(Boolean).join('\n')
    case 'listItem':
      return node.children.map(nodeText).filter(Boolean).join(' ')
    case 'tableRow':
      return node.children.map(nodeText).join('\t')
    case 'text':
    case 'inlineCode':
    case 'html':
      return node.value
    case 'image':
    case 'imageReference':
      return node.alt || ''
    case 'break':
      return '\n'
    default:
      return 'children' in node ? node.children.map(nodeText).join('') : ''
  }
}

function findFirstParagraph(node: Nodes): string | undefined {
  if (node.type === 'paragraph') {
    const text = nodeText(node)
    if (text !== '') return text
  }
  for (const child of 'children' in node ? node.children : []) {
    const text = findFirstParagraph(child)
    if (text !== undefined) return text
  }
  return undefined
}

function fullText(root: Nodes): string {
  return nodeText(root)
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Parse GFM Markdown, remove its presentation markup, and preserve raw HTML literally.
 * @param markdown - Markdown source.
 * @param options - Optional extraction boundary.
 * @returns Plain text for the whole document, first visible line, or first semantic paragraph.
 */
export function extractMarkdownPlainText(
  markdown: string,
  options: MarkdownPlainTextOptions = {},
): string {
  const { mode = 'all' } = options
  const root = parseGfm(markdown)
  const all = fullText(root)
  const newline = all.indexOf('\n')
  const firstLine = newline === -1 ? all : all.slice(0, newline)
  switch (mode) {
    case 'all':
      return all
    case 'first-line':
      return firstLine
    case 'first-paragraph':
      return findFirstParagraph(root) ?? firstLine
  }
}
