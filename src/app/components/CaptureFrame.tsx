import type { ReactNode, RefObject } from 'react'
import type { GridStyle } from '../../core/types.ts'
import { AlignmentGrid } from './AlignmentGrid.tsx'

export interface CaptureFrameProps {
  videoRef: RefObject<HTMLVideoElement | null>
  /** Whether the live preview is showing a reflection. */
  mirrored: boolean
  gridStyle: GridStyle
  ghostUrl: string | null
  ghostOpacity: number
  /**
   * True when the ghost's stored pixels are in the opposite mirroring to the
   * current preview — the only case where the ghost needs a transform at all.
   */
  ghostFlipped: boolean
  onTap?: () => void
  tapLabel?: string
  children?: ReactNode
}

/**
 * The capture frame: one 3:4 box holding the preview, the ghost and the guides.
 *
 * All three layers are the same box with the same `object-fit: cover`, and
 * stored photos are already 3:4, so the ghost maps onto the preview one-to-one.
 * There is deliberately no positioning maths here — the moment a layer needed
 * its own offsets, the ghost could disagree with what gets saved.
 */
export function CaptureFrame({
  videoRef,
  mirrored,
  gridStyle,
  ghostUrl,
  ghostOpacity,
  ghostFlipped,
  onTap,
  tapLabel,
  children,
}: CaptureFrameProps) {
  return (
    <div className="frame" data-testid="capture-frame">
      <video
        ref={videoRef}
        className="frame__video"
        data-testid="capture-video"
        data-mirrored={mirrored}
        playsInline
        muted
        autoPlay
      />

      {ghostUrl ? (
        <img
          className="frame__ghost"
          data-testid="ghost-image"
          data-flipped={ghostFlipped}
          src={ghostUrl}
          alt=""
          style={{ opacity: ghostOpacity }}
          draggable={false}
        />
      ) : null}

      <AlignmentGrid style={gridStyle} />

      {onTap ? (
        /*
         * The whole frame is a shutter. Phones have no volume-button shutter
         * available to a web app — the ergonomic trick users of the native apps
         * ask for most — so the largest possible target is the next best thing.
         * Hidden from assistive tech because the real shutter button below is
         * already labelled and focusable; this is a touch affordance, not a
         * second control.
         */
        <button
          type="button"
          className="frame__tap"
          onClick={onTap}
          title={tapLabel}
          aria-hidden="true"
          tabIndex={-1}
          data-testid="frame-tap"
        />
      ) : null}

      {children}
    </div>
  )
}
