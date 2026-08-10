import type { GridStyle } from '../../core/types.ts'

/**
 * Alignment guides, drawn in frame space.
 *
 * The viewBox is 300x400 — the frame's own aspect — so every guide sits at a
 * fixed fraction of the captured image no matter what size the preview is
 * rendered at. The eye line at 40% height is the one that actually does the
 * work: faces line up by their eyes, not by their outline.
 */
export function AlignmentGrid({ style }: { style: GridStyle }) {
  if (style === 'off') return null

  return (
    <svg
      className="frame__grid"
      viewBox="0 0 300 400"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      {style === 'thirds' ? (
        <g className="frame__grid-lines">
          <path d="M100 0V400M200 0V400" />
          <path d="M0 133.33H300M0 266.67H300" />
        </g>
      ) : (
        <>
          <g className="frame__grid-lines">
            <path d="M150 0V400" />
            <path d="M0 160H300" />
          </g>
          <g className="frame__grid-marks">
            <circle cx="150" cy="160" r="46" />
            <path d="M150 148v24M138 160h24" />
          </g>
        </>
      )}
    </svg>
  )
}
