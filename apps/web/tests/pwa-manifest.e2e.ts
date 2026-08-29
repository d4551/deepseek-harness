import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(index).toContain('rel="apple-touch-icon"')
  expect(manifest).toMatchObject({
    id: '/',
    name: 'DeepMeow',
    short_name: 'DeepMeow',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [
      {
        src: '/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-192-maskable.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icon-512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  })
  if (typeof manifest !== 'object' || manifest === null) {
    throw new TypeError('install manifest must be a JSON object')
  }
  const themeColor = Reflect.get(manifest, 'theme_color')
  const backgroundColor = Reflect.get(manifest, 'background_color')
  expect(typeof themeColor).toBe('string')
  expect(backgroundColor).toBe(themeColor)
})

it('ships Chromium and Apple raster icons at their required edges', async () => {
  const files: ReadonlyArray<readonly [string, number]> = [
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-192-maskable.png', 192],
    ['icon-512-maskable.png', 512],
    ['apple-touch-icon.png', 180],
  ]
  for (const [name, edge] of files) {
    const bytes = await readFile(join(DIST_ROOT, name))
    expect(bytes.readUInt32BE(16)).toBe(edge)
    expect(bytes.readUInt32BE(20)).toBe(edge)
  }
})

it('ships a favicon that switches to a light mark under dark color scheme', async () => {
  const favicon = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  // The light fill must live inside the dark-scheme media query, so the icon
  // stays black in light mode and only turns white under a dark scheme.
  expect(favicon).toMatch(/@media \(prefers-color-scheme: dark\)\s*{\s*path\s*{[^}]*fill:\s*#fff/i)
  expect(favicon).toContain('fill="#000"')
})
