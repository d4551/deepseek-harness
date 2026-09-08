/**
 * axe over this package's rendered surfaces.
 *
 * The primitives lane audits components that ship as exports. These do not:
 * the package exports a plugin, and its components are composed internally,
 * so they are audited here in the states a user actually meets — a rail with
 * pending images, the drop overlay, the lightbox, and a message image.
 */

import { cleanup, render } from '@testing-library/react'
import { AttachmentId } from '@deepseek-ai/dsh-attachment/src/brand.ts'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
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

const canvas = document.createElement('canvas')
canvas.width = 640
canvas.height = 320
const context = canvas.getContext('2d')
if (context === null) throw new Error('Image accessibility requires native canvas support')
context.fillRect(0, 0, canvas.width, canvas.height)
const imageUrl = canvas.toDataURL('image/png')

const railLabels: AttachmentRailLabels = {
  group: '待发送图片',
  open: '查看原图',
  scrollLeft: '向左滚动图片',
  scrollRight: '向右滚动图片',
}

const railItems: AttachmentRailItem[] = [
  { id: 'a', previewUrl: imageUrl, alt: 'a.png', removeLabel: '移除图片 a.png' },
  { id: 'b', previewUrl: imageUrl, alt: 'b.png', removeLabel: '移除图片 b.png' },
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
      src={imageUrl}
      alt="原图"
      labels={{ dialog: '原图预览', close: '关闭原图预览' }}
      onClose={() => {}}
    />
  ),
  MessageImage: () => (
    <MessageImage
      image={{
        attachment: {
          attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
          mediaType: 'image/png' as const,
          bytes: 68,
          width: 640,
          height: 320,
          name: 'history.png',
        },
      }}
      load={() => Promise.resolve(imageUrl)}
      variant="single"
      labels={imageLabels}
    />
  ),
}

describe('ui-attachment accessibility', () => {
  it('renders no accessibility violations and holds the aggregate score', async () => {
    const audits: SurfaceAudit[] = []
    for (const [surface, mount] of Object.entries(SURFACES)) {
      const { baseElement } = render(<main>{mount()}</main>)
      audits.push(await auditSurface(surface, baseElement))
      cleanup()
    }
    for (const audit of audits) {
      expect(audit.passed + audit.failed, `${audit.surface} decided no checks`).toBeGreaterThan(0)
    }
    expect(audits.flatMap(audit => audit.undecidedRules)).toEqual([])
    expect(accessibilityFailures(audits, MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })
})
