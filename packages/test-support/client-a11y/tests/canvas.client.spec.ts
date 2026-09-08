// @vitest-environment jsdom
import { expect, it } from 'vitest'

it('provides real canvas pixel operations in the jsdom client lane', () => {
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Client tests require the jsdom canvas peer')
  context.fillStyle = 'rgb(20, 40, 60)'
  context.fillRect(0, 0, 1, 1)
  expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([20, 40, 60, 255])
  expect([...context.getImageData(1, 1, 1, 1).data]).toEqual([0, 0, 0, 0])
})
