// @vitest-environment jsdom
/**
 * axe over this package's rendered surfaces.
 *
 * The primitives lane audits components that ship as exports. These do not:
 * the package exports a plugin, and its components are composed internally,
 * so they are audited here in the states a user actually meets — a rail with
 * pending images, the drop overlay, the lightbox, and a message image.
 */

import { cleanup, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accessibilityScore, auditSurface, formatViolations } from '@deepseek-ai/dsh-client-a11y'
import type { SurfaceAudit } from '@deepseek-ai/dsh-client-a11y'
import { AttachmentRail } from '../src/AttachmentRail.tsx'
import type { AttachmentRailItem, AttachmentRailLabels } from '../src/AttachmentRail.tsx'
import { DropOverlay } from '../src/DropOverlay.tsx'
import { ImageLightbox } from '../src/ImageLightbox.tsx'
import { MessageImage } from '../src/MessageImage.tsx'
import type { MessageImageLabels } from '../src/MessageImage.tsx'

/** Equal to the recorded score: every decided check passes, so any failure fails the run. */
const MINIMUM_ACCESSIBILITY_SCORE = 100

afterEach(cleanup)

const railLabels: AttachmentRailLabels = {
  group: '待发送图片',
  open: '查看原图',
  scrollLeft: '向左滚动图片',
  scrollRight: '向右滚动图片',
}

const railItems: AttachmentRailItem[] = [
  { id: 'a', previewUrl: 'blob:a', alt: 'a.png', removeLabel: '移除图片 a.png' },
  { id: 'b', previewUrl: 'blob:b', alt: 'b.png', removeLabel: '移除图片 b.png' },
]

const imageLabels: MessageImageLabels = {
  image: '图片',
  open: '查看原图',
  openNamed: label => `${label}，点击查看原图`,
  loading: '图片加载中…',
  loadFailed: '图片加载失败，点击重试',
  lightbox: { dialog: '原图预览', close: '关闭原图预览' },
}

const SURFACES: Readonly<Record<string, () => ReactElement>> = {
  AttachmentRail: () => (
    <AttachmentRail items={railItems} labels={railLabels} onOpen={() => {}} onRemove={() => {}} />
  ),
  DropOverlay: () => (
    <DropOverlay disabled={false} labels={{ title: '图片拖动到此处即可添加', desc: '最多 20 张，每张 5MB' }} />
  ),
  ImageLightbox: () => (
    <ImageLightbox
      src="blob:original"
      alt="原图"
      labels={{ dialog: '原图预览', close: '关闭原图预览' }}
      onClose={() => {}}
    />
  ),
  MessageImage: () => (
    <MessageImage
      image={{ attachment: { id: 'att-1', name: 'history.png', mediaType: 'image/png', bytes: 4 } }}
      load={() => Promise.resolve('blob:seeded')}
      variant="single"
      labels={imageLabels}
    />
  ),
}

describe('ui-attachment accessibility', () => {
  it('renders no accessibility violations and holds the aggregate score', async () => {
    // A ResizeObserver the rail measures with; jsdom provides none.
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    try {
      const audits: SurfaceAudit[] = []
      for (const [surface, mount] of Object.entries(SURFACES)) {
        // The page shell supplies the `main` landmark; without one the audit
        // reports the harness's missing page frame against every surface.
        const { baseElement } = render(<main>{mount()}</main>)
        audits.push(await auditSurface(surface, baseElement))
        cleanup()
      }

      // A surface that decided nothing scores 100 for free.
      for (const audit of audits) {
        expect(audit.passed + audit.failed, `${audit.surface} decided no checks`).toBeGreaterThan(0)
      }
      // jsdom computes no layout, so contrast decides nothing; asserting the
      // set keeps a newly undecidable rule from silently leaving the score.
      expect([...new Set(audits.flatMap(audit => audit.undecidedRules))]).toEqual(['color-contrast'])

      expect(audits.map(formatViolations).filter(text => text !== '').join('\n')).toBe('')
      expect(accessibilityScore(audits)).toBeGreaterThanOrEqual(MINIMUM_ACCESSIBILITY_SCORE)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
