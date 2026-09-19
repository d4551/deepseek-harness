/** Raster inspection: full decode at admission, header-only probe on verified reads. */

import sharp, { type Sharp } from 'sharp'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Values a Promise reject arm may deliver. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

/** Decoded metadata from a supported image. */
export interface DetectedImage {
  mediaType: ImageMediaType
  /** Intrinsic width with EXIF orientation applied — the width a viewer perceives. */
  width: number
  /** Intrinsic height with EXIF orientation applied — the height a viewer perceives. */
  height: number
  /** Whether the container carries more than one frame. */
  animated: boolean
  /** Whether the bytes carry descriptive metadata, a color profile, or orientation. */
  carriesMetadata: boolean
  /** Sharp sample depth reported for the decoded channels. */
  depth: string
  /** Sharp colour space reported for the decoded pixels. */
  space: string
  /** Whether decoded pixels carry an alpha channel. */
  hasAlpha: boolean
}

/**
 * Check alpha metadata for bytes produced by this package's encoders.
 * Sharp/libvips may omit an all-opaque alpha plane from WebP output; every
 * other addition or removal indicates that the encoded result is incompatible
 * with its source facts.
 * @param sourceHasAlpha - whether the source bytes declare an alpha plane, or undefined when the source frame is unspecified.
 * @param output - decoded media type and alpha metadata from the encoded result.
 * @returns whether the output alpha metadata is compatible with the source.
 */
export function encodedAlphaIsCompatible(
  sourceHasAlpha: boolean | undefined,
  output: Pick<DetectedImage, 'mediaType' | 'hasAlpha'>,
): boolean {
  return sourceHasAlpha === undefined
    || output.hasAlpha === sourceHasAlpha
    || (sourceHasAlpha && !output.hasAlpha && output.mediaType === 'image/webp')
}

const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function carriesRetainedMetadata(metadata: Awaited<ReturnType<Sharp['metadata']>>): boolean {
  return metadata.exif !== undefined
    || metadata.xmp !== undefined
    || metadata.iptc !== undefined
    || metadata.icc !== undefined
    || metadata.hasProfile
    || metadata.tifftagPhotoshop !== undefined
    || metadata.comments !== undefined
    || metadata.orientation !== undefined
}

function invalidImage(error: Thrown): never {
  if (error instanceof AttachmentError) throw error
  throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
}

async function imageMetadata(image: Sharp): Promise<DetectedImage> {
  const metadata = await image.metadata()
  const mediaType = MEDIA_TYPES[metadata.format as string]
  if (mediaType === undefined) {
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
  }
  // EXIF orientations 5-8 transpose the stored raster; report the perceived
  // axes so limits, source facts, and coordinate advice all share them.
  const transposed = metadata.orientation !== undefined && metadata.orientation >= 5
  return {
    mediaType,
    width: transposed ? metadata.height : metadata.width,
    height: transposed ? metadata.width : metadata.height,
    animated: (metadata.pages ?? 1) > 1,
    carriesMetadata: carriesRetainedMetadata(metadata),
    depth: metadata.depth,
    space: metadata.space,
    hasAlpha: metadata.hasAlpha,
  }
}

/**
 * Parse a supported raster's header and return its intrinsic metadata without
 * decoding pixels. Digest-verified reads use this: admission already proved
 * that these exact bytes decode completely, so the read path only re-derives
 * the reference fields instead of paying the full-raster decode again.
 * @param data - complete encoded image bytes.
 * @returns verified format and dimensions.
 */
export async function probeImage(data: Uint8Array): Promise<DetectedImage> {
  return await imageMetadata(sharp(data, { failOn: 'error', limitInputPixels: false })).then(
    undefined,
    (error: Thrown) => invalidImage(error),
  )
}

/** Admission limits applied to a decoded raster's intrinsic dimensions. */
export interface DecodedImageLimits {
  /** Decoded-pixel (width times height) admission limit. */
  maxPixels?: number
  /** Per-side admission limit applied to width and height independently. */
  maxDimension?: number
}

/**
 * Fully decode a supported raster and return its intrinsic metadata.
 * @param data - complete encoded image bytes.
 * @param limits - intrinsic-dimension admission limits.
 * @returns verified format and dimensions.
 */
export async function detectImage(data: Uint8Array, limits?: DecodedImageLimits): Promise<DetectedImage> {
  const image = sharp(data, { failOn: 'error', limitInputPixels: false })
  return await imageMetadata(image).then(
    (detected) => {
      if (limits?.maxPixels !== undefined && detected.width * detected.height > limits.maxPixels) {
        throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
      }
      if (limits?.maxDimension !== undefined && Math.max(detected.width, detected.height) > limits.maxDimension) {
        throw new AttachmentError('Image exceeds the configured per-side pixel limit.', 'IMAGE_DIMENSION_TOO_LARGE')
      }
      return image.raw().toBuffer().then(
        () => detected,
        (error: Thrown) => invalidImage(error),
      )
    },
    (error: Thrown) => invalidImage(error),
  )
}
