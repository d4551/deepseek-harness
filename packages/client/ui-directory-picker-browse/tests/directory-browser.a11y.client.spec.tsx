// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import { DirectoryBrowser } from '../src/client/DirectoryBrowser.tsx'

afterEach(cleanup)

const HOME: DirectoryListing = {
  path: '/home/u',
  home: '/home/u',
  crumbs: [
    { name: '/', path: '/', hidden: false },
    { name: 'u', path: '/home/u', hidden: false },
  ],
  entries: [{ name: 'Documents', path: '/home/u/Documents', hidden: false }],
  truncated: false,
}

describe('directory browser accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders no accessibility violations while open', async () => {
    const { baseElement } = render(
      <main>
        <DirectoryBrowser
          open
          listDirectory={vi.fn(async () => HOME)}
          createDirectory={vi.fn(async (path, name) => `${path}/${name}`)}
          onOpen={vi.fn()}
          onClose={vi.fn()}
          busy={false}
          t={key => key}
        />
      </main>,
    )
    await screen.findByRole('dialog')
    expect(accessibilityFailures(
      [await auditSurface('DirectoryBrowser open', baseElement)],
      MINIMUM_ACCESSIBILITY_SCORE,
    )).toBe('')
  })
})
