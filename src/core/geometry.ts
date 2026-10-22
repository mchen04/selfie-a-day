/**
 * The single source of truth for the app's coordinate space.
 *
 * The whole product depends on one invariant:
 *
 *   what the user aligned against === what gets saved === what becomes the ghost
 *
 * We hold that by construction rather than by care:
 *
 *  1. The preview frame is a box of fixed aspect `FRAME_ASPECT`, and the video is
 *     rendered into it with CSS `object-fit: cover`.
 *  2. Capture reproduces that exact cover-crop on a canvas whose aspect is also
 *     `FRAME_ASPECT`, so the stored image *is* the visible frame, nothing more.
 *  3. Because the stored image already has `FRAME_ASPECT`, drawing it back into
 *     the same frame box with `object-fit: cover` is the identity mapping. The
 *     ghost therefore cannot drift relative to the preview — there is no second
 *     transform that could disagree.
 *
 * Everything here is pure so it can be unit-tested without a DOM, and verified
 * against real pixels by an end-to-end test using a known camera target.
 */

/** Portrait 3:4 — matches how phones frame a face and how iOS stores stills. */
export const FRAME_ASPECT = 3 / 4

export interface CoverCrop {
  /** Source rectangle, in source-image pixels. */
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * The sub-rectangle of a source image that CSS `object-fit: cover` keeps visible
 * inside a box of aspect `frameAspect`.
 *
 * Note the result depends only on the source dimensions and the *aspect* of the
 * box, never on the box's pixel size — which is precisely why a 390px-wide phone
 * preview and a 1080px-wide capture canvas show the same pixels.
 */
export function computeCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  frameAspect: number = FRAME_ASPECT,
): CoverCrop {
  if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(frameAspect > 0)) {
    throw new RangeError(
      `computeCoverCrop needs positive dimensions, got ${sourceWidth}x${sourceHeight} @ ${frameAspect}`,
    )
  }

  // Widest crop that still fits the source while matching the frame's aspect.
  const sw = Math.min(sourceWidth, frameAspect * sourceHeight)
  const sh = sw / frameAspect

  return {
    sx: (sourceWidth - sw) / 2,
    sy: (sourceHeight - sh) / 2,
    sw,
    sh,
  }
}

/**
 * Output pixel dimensions for a capture at a given long-edge budget, rounded to
 * even numbers so encoders never disagree about chroma subsampling.
 */
export function outputSize(longEdge: number, frameAspect: number = FRAME_ASPECT): {
  width: number
  height: number
} {
  const height = Math.round(longEdge / 2) * 2
  const width = Math.round((height * frameAspect) / 2) * 2
  return { width, height }
}

/**
 * True when an image can be rendered into a `frameAspect` box with no cropping,
 * i.e. it is already in frame space. Stored photos must always satisfy this; a
 * failure here means the ghost would be showing a different framing than the
 * capture did, which is the exact bug this app exists to avoid.
 */
export function isFrameSpace(
  width: number,
  height: number,
  frameAspect: number = FRAME_ASPECT,
  tolerance = 0.01,
): boolean {
  if (!(width > 0) || !(height > 0)) return false
  return Math.abs(width / height - frameAspect) <= tolerance
}
