/**
 * DeepSeek V4.1 vision-token accounting from the provider's published calculator:
 * https://api-docs.deepseek.com/quick_start/token_usage/
 * The provider resizes every request image onto a 14px-patch grid, downsamples
 * 3:1 per axis, and caps one image at 1024 tokens. Actual usage remains authoritative.
 *
 * @module dsh-llm-deepseek/image-tokens
 */

/** Vision patch edge in pixels. */
const PATCH_SIZE = 14
/** Per-axis patch-to-token downsampling ratio. */
const DOWNSAMPLE_RATIO = 3
/** Provider cap on tokens for one request image. */
const MAX_IMAGE_TOKENS = 1024
/** Total-pixel floor; smaller images are scaled up before grid projection. */
const MIN_PIXELS = 544 * 544

const intDiv = (value: number, divisor: number): number => Math.floor(value / divisor)
const ceilDiv = (value: number, divisor: number): number => Math.floor((value + divisor - 1) / divisor)

interface GridResize {
  readonly gridHeight: number
  readonly gridWidth: number
  readonly bestHeight: number
  readonly bestWidth: number
  readonly numTokens: number
}

/** Token count of one grid, including row separators and framing. */
function gridTokens(gridHeight: number, gridWidth: number): number {
  return gridHeight * (gridWidth + 1) + 2
}

/** Solve the largest grid within `budget` tokens preserving the aspect ratio. */
function solveResizeRatio(height: number, width: number, budget: number): GridResize {
  const aspect = height / width
  const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5
  const idealGridHeight = idealGridWidth * aspect
  let bestHeight: number
  let bestWidth: number
  if (idealGridWidth < 1) {
    const solvedGridWidth = 1
    const solvedGridHeight = intDiv(budget - 2, solvedGridWidth + 1)
    bestWidth = solvedGridWidth * PATCH_SIZE * DOWNSAMPLE_RATIO
    bestHeight = solvedGridHeight * PATCH_SIZE * DOWNSAMPLE_RATIO
  } else if (idealGridHeight < 1) {
    const solvedGridHeight = 1
    const solvedGridWidth = intDiv(budget - 2, solvedGridHeight) - 1
    if (!(solvedGridWidth > 1)) throw new Error('deepseek image tokens: no grid fits the token budget')
    bestWidth = solvedGridWidth * PATCH_SIZE * DOWNSAMPLE_RATIO
    bestHeight = solvedGridHeight * PATCH_SIZE * DOWNSAMPLE_RATIO
  } else {
    const solvedGridWidth = Math.trunc(idealGridWidth)
    const solvedGridHeight = Math.trunc(idealGridHeight)
    const widthScale = solvedGridWidth * PATCH_SIZE * DOWNSAMPLE_RATIO / width
    const heightScale = solvedGridHeight * PATCH_SIZE * DOWNSAMPLE_RATIO / height
    const scale = Math.min(widthScale, heightScale)
    bestWidth = Math.trunc(width * scale / PATCH_SIZE) * PATCH_SIZE
    bestHeight = Math.trunc(height * scale / PATCH_SIZE) * PATCH_SIZE
  }
  const gridHeight = ceilDiv(intDiv(bestHeight, PATCH_SIZE), DOWNSAMPLE_RATIO)
  const gridWidth = ceilDiv(intDiv(bestWidth, PATCH_SIZE), DOWNSAMPLE_RATIO)
  return { gridHeight, gridWidth, bestHeight, bestWidth, numTokens: gridTokens(gridHeight, gridWidth) }
}

/** Project padded pixel dimensions onto the largest in-budget token grid. */
function safeResize(height: number, width: number, paddedHeight: number, paddedWidth: number): GridResize {
  const gridHeight = ceilDiv(intDiv(paddedHeight, PATCH_SIZE), DOWNSAMPLE_RATIO)
  const gridWidth = ceilDiv(intDiv(paddedWidth, PATCH_SIZE), DOWNSAMPLE_RATIO)
  const budget = MAX_IMAGE_TOKENS
  let result: GridResize = {
    gridHeight,
    gridWidth,
    bestHeight: paddedHeight,
    bestWidth: paddedWidth,
    numTokens: gridTokens(gridHeight, gridWidth),
  }
  if (result.numTokens > budget) {
    result = solveResizeRatio(height, width, budget)
    if (!(result.numTokens <= budget)) throw new Error('deepseek image tokens: resized grid exceeds the token budget')
  }
  return result
}

/** One scale-pad-project pass; the caller iterates it to a fixpoint. */
function resizeOnce(width: number, height: number): GridResize {
  const pixels = width * height
  if (pixels < MIN_PIXELS) {
    const scale = Math.sqrt(MIN_PIXELS / pixels)
    width = Math.trunc(width * scale)
    height = Math.trunc(height * scale)
  }
  const paddedWidth = ceilDiv(width, PATCH_SIZE) * PATCH_SIZE
  const paddedHeight = ceilDiv(height, PATCH_SIZE) * PATCH_SIZE
  return safeResize(height, width, paddedHeight, paddedWidth)
}

function sameResize(a: GridResize, b: GridResize): boolean {
  return a.gridHeight === b.gridHeight
    && a.gridWidth === b.gridWidth
    && a.bestHeight === b.bestHeight
    && a.bestWidth === b.bestWidth
    && a.numTokens === b.numTokens
}

/**
 * Estimate DeepSeek V4.1 vision tokens for one request image.
 * @param width - positive integer request-image width in pixels.
 * @param height - positive integer request-image height in pixels.
 * @returns the provider vision-token estimate, at most 1024.
 * @throws RangeError when either dimension is not a positive safe integer.
 * @throws Error when the provider projection exceeds its budget or fails to converge.
 */
export function deepSeekImageTokens(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError('deepseek image tokens: dimensions must be positive safe integers')
  }
  let result = resizeOnce(width, height)
  for (let iteration = 1; iteration < 10; iteration += 1) {
    const next = resizeOnce(result.bestWidth, result.bestHeight)
    if (sameResize(next, result)) return result.numTokens
    result = next
  }
  throw new Error(`deepseek image tokens: resize did not converge for ${width}x${height}`)
}
