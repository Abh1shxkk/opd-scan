/**
 * Region overlays drawn over a page render.
 *
 * COORDINATE SCALING — the thing that is easy to get wrong here
 * -------------------------------------------------------------
 * Every region and polygon the API returns is expressed in ORIGINAL RENDER PIXELS, i.e. the
 * `page.width` × `page.height` space of the page version. What is on screen is almost never that
 * size: the viewer fits the page to the pane and then applies a zoom factor, and the preview route
 * serves a bounded-size image that is itself a different pixel size again. So a finding at
 * x = 2900 on a 3300 px wide page must be drawn at 2900 × (displayedWidth / 3300) CSS pixels.
 *
 * Rather than multiply every coordinate by hand — which is where an off-by-a-factor bug hides —
 * the SVG declares `viewBox="0 0 pageWidth pageHeight"` and is sized to the displayed box with
 * `preserveAspectRatio="none"`. The browser then applies exactly the ratio
 * `displayedWidth / pageWidth` (and the vertical equivalent) to every coordinate inside. The two
 * ratios are still computed explicitly below, because stroke widths and label text must NOT be
 * scaled — a 2 px outline has to stay 2 screen pixels whether the user is at 25 % or 400 % zoom,
 * so those are divided by the scale to cancel the viewBox transform out again.
 *
 * ROTATION
 * --------
 * The overlay is deliberately *not* rotation-aware. It is rendered inside the same wrapper element
 * as the <img>, and the caller rotates that wrapper (see `RotatableStage` below). Because the
 * overlay and the image are children of one rotated box, they cannot drift apart: any rotation,
 * flip or future transform applies to both by construction. Rotating the overlay separately from
 * the image would need the inverse transform in two places and would break the first time the two
 * disagreed.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';
import type { Polygon, Region } from '../lib/types';

export type OverlayKind = 'quality' | 'handwriting' | 'diagnosis';

export interface OverlayShape {
  id: string;
  kind: OverlayKind;
  /** Axis-aligned box in original render pixels. Either this or `polygon` must be present. */
  region?: Region | null;
  /** Free polygon in original render pixels. */
  polygon?: Polygon | null;
  /** Short caption drawn at the top-left of the shape. */
  label: string;
  /** Longer text exposed to assistive technology and on hover. */
  description?: string;
  selected?: boolean;
  /** Dashed outline: used for findings the engine states as a suspicion, e.g. suspected cut-off. */
  tentative?: boolean;
}

/**
 * Each family gets a distinct colour AND a distinct dash pattern AND a labelled caption, so the
 * three kinds remain distinguishable in greyscale and to colour-blind readers.
 */
const KIND_STYLE: Record<OverlayKind, { stroke: string; fill: string; dash: string; caption: string }> = {
  quality: { stroke: '#dc2626', fill: 'rgba(220,38,38,0.10)', dash: '', caption: 'Scan defect' },
  handwriting: {
    stroke: '#7c3aed',
    fill: 'rgba(124,58,237,0.10)',
    dash: '10 6',
    caption: 'Handwriting',
  },
  diagnosis: { stroke: '#0891b2', fill: 'rgba(8,145,178,0.12)', dash: '2 6', caption: 'Diagnosis' },
};

export function overlayKindCaption(kind: OverlayKind): string {
  return KIND_STYLE[kind].caption;
}

export function overlayKindColour(kind: OverlayKind): string {
  return KIND_STYLE[kind].stroke;
}

function polygonPoints(poly: Polygon): string {
  return poly.map(([x, y]) => `${x},${y}`).join(' ');
}

function shapeAnchor(shape: OverlayShape): { x: number; y: number } | null {
  if (shape.region) return { x: shape.region.x, y: shape.region.y };
  if (shape.polygon && shape.polygon.length > 0) {
    const xs = shape.polygon.map((p) => p[0]);
    const ys = shape.polygon.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys) };
  }
  return null;
}

export function OverlayCanvas({
  pageWidth,
  pageHeight,
  displayedWidth,
  displayedHeight,
  shapes,
  onSelect,
  showLabels = true,
}: {
  /** Original render dimensions — the coordinate space the API's regions live in. */
  pageWidth: number;
  pageHeight: number;
  /** CSS pixel size of the image as currently laid out. */
  displayedWidth: number;
  displayedHeight: number;
  shapes: OverlayShape[];
  onSelect?: (id: string) => void;
  showLabels?: boolean;
}) {
  const clipId = useId();

  // A page version with no recorded dimensions cannot be used to place anything. Drawing the
  // regions at 1:1 would put them in the wrong place, so nothing is drawn at all.
  if (!pageWidth || !pageHeight || !displayedWidth || !displayedHeight) return null;

  // The scale the API contract names: displayed_width / page.width.
  const scaleX = displayedWidth / pageWidth;
  const scaleY = displayedHeight / pageHeight;
  // Used to keep stroke and text at a constant SCREEN size: dividing by the scale cancels the
  // viewBox magnification, so `2 / scale` user units always render as 2 CSS pixels.
  const strokeScale = Math.max(scaleX, scaleY) || 1;
  const px = (n: number) => n / strokeScale;

  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={displayedWidth}
      height={displayedHeight}
      viewBox={`0 0 ${pageWidth} ${pageHeight}`}
      preserveAspectRatio="none"
      role="group"
      aria-label={`${shapes.length} highlighted region${shapes.length === 1 ? '' : 's'} on this page`}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width={pageWidth} height={pageHeight} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {shapes.map((shape) => {
          const style = KIND_STYLE[shape.kind];
          const anchor = shapeAnchor(shape);
          const strokeWidth = px(shape.selected ? 4 : 2.5);
          const dash = shape.tentative ? `${px(12)} ${px(8)}` : style.dash
            ? style.dash
                .split(' ')
                .map((n) => px(Number(n)))
                .join(' ')
            : undefined;

          const common = {
            fill: shape.selected ? style.fill : 'transparent',
            stroke: style.stroke,
            strokeWidth,
            strokeDasharray: dash,
            // The shapes themselves accept clicks even though the <svg> does not, so the image
            // underneath stays draggable/zoomable everywhere else.
            className: onSelect ? 'pointer-events-auto cursor-pointer' : undefined,
            onClick: onSelect ? () => onSelect(shape.id) : undefined,
          } as const;

          return (
            <g key={shape.id}>
              <title>
                {style.caption}: {shape.label}
                {shape.description ? ` — ${shape.description}` : ''}
              </title>
              {shape.region ? (
                <rect
                  x={shape.region.x}
                  y={shape.region.y}
                  width={Math.max(shape.region.w, 1)}
                  height={Math.max(shape.region.h, 1)}
                  {...common}
                />
              ) : null}
              {shape.polygon && shape.polygon.length >= 3 ? (
                <polygon points={polygonPoints(shape.polygon)} {...common} />
              ) : null}

              {showLabels && anchor ? (
                <g transform={`translate(${anchor.x} ${anchor.y})`}>
                  {/* Caption drawn at constant screen size, sitting just above the shape. */}
                  <rect
                    x={0}
                    y={px(-18)}
                    width={px(Math.max(shape.label.length * 6.4 + 10, 30))}
                    height={px(16)}
                    rx={px(3)}
                    fill={style.stroke}
                  />
                  <text
                    x={px(5)}
                    y={px(-6)}
                    fill="#ffffff"
                    fontSize={px(11)}
                    fontFamily="system-ui, sans-serif"
                    style={{ userSelect: 'none' }}
                  >
                    {shape.label}
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/**
 * The rotating wrapper.
 *
 * The image and the overlay are laid out in an un-rotated box of `width` × `height`; that box is
 * then rotated as a whole. The outer element swaps its width and height at 90° and 270° so the
 * rotated content still reserves the right amount of space in the scrolling pane.
 */
export function RotatableStage({
  width,
  height,
  rotation,
  children,
}: {
  width: number;
  height: number;
  /** Degrees clockwise; only right angles are offered, which is what a rescan would correct. */
  rotation: 0 | 90 | 180 | 270;
  children: ReactNode;
}) {
  const quarterTurn = rotation === 90 || rotation === 270;
  const outerWidth = quarterTurn ? height : width;
  const outerHeight = quarterTurn ? width : height;

  return (
    <div style={{ width: outerWidth, height: outerHeight }} className="relative">
      <div
        className="absolute"
        style={{
          width,
          height,
          // Rotate about the centre of the un-rotated box, then shift so the rotated result sits
          // flush in the outer box.
          left: (outerWidth - width) / 2,
          top: (outerHeight - height) / 2,
          transform: `rotate(${rotation}deg)`,
          transformOrigin: 'center center',
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Legend shown beside the viewer. Text, not colour alone. */
export function OverlayLegend({ kinds }: { kinds: OverlayKind[] }) {
  if (kinds.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700 dark:text-slate-300">
      {kinds.map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-5 rounded-sm border-2"
            style={{ borderColor: KIND_STYLE[k].stroke, borderStyle: k === 'quality' ? 'solid' : 'dashed' }}
          />
          {KIND_STYLE[k].caption}
        </li>
      ))}
    </ul>
  );
}
