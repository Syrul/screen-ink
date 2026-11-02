// The pieces marks are drawn with: pen strokes revealed the way a pen draws them, pills and badges that pop in,
// fades, and where to put a piece beside what it is about.
import { getStroke } from 'perfect-freehand'
import type { Point } from '../shared/marks'
import { clamp, easeBack, easePen, el, textWidth, UI_FONT, type Beat } from './common'
import { lengthOf, outlinePath, slice, type Rect } from './shapes'
import { scratch, tap } from './sounds'

export const PEN = 4 // the pen's width in points
export const HAND_FONT = '"Chalkboard SE", "Marker Felt", "Comic Sans MS", cursive'

export function pen(g: Element, pts: Point[], color: string, o: { size?: number; opacity?: number; speed?: number } = {}): Beat {
  const len = lengthOf(pts)
  const size = o.size ?? PEN
  let path: SVGPathElement
  return {
    dur: clamp(len / (o.speed ?? 1000), 0.16, 0.9),
    start: () => {
      path = el('path', { fill: color, opacity: o.opacity ?? 1 }, g)
      scratch(clamp(len / (o.speed ?? 1000), 0.16, 0.9))
    },
    frame: t => {
      const part = slice(pts, 0, len * easePen(t))
      if (part.length < 2) return
      const outline = getStroke(part, { size, thinning: 0, smoothing: 0.6, streamline: 0.3, simulatePressure: false, last: t >= 1 })
      path.setAttribute('d', outlinePath(outline))
    },
  }
}

/** Pops a node built around the origin in at `center`. */
export function pop(g: Element, build: () => SVGGElement, center: Point): Beat {
  let node: SVGGElement
  return {
    dur: 0.32,
    start: () => {
      g.append((node = build()))
      tap()
    },
    frame: t => {
      node.setAttribute('transform', `translate(${center[0]} ${center[1]}) scale(${0.5 + 0.5 * easeBack(t)})`)
      node.setAttribute('opacity', String(clamp(t * 3, 0, 1)))
    },
  }
}

export function fadeIn(g: Element, build: () => SVGElement, to = 1, dur = 0.35, together = false): Beat {
  let node: SVGElement
  return { dur, together, start: () => g.append((node = build())), frame: t => node.setAttribute('opacity', String(to * t)) }
}

// ---- pieces

export function pill(text: string, color: string): { build: () => SVGGElement; w: number; h: number } {
  const h = 24
  const w = Math.ceil(textWidth(text, `600 13px ${UI_FONT}`)) + 22
  const build = () => {
    const g = el('g', {})
    el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: h / 2, fill: color }, g)
    const label = el('text', { fill: '#FFFFFF', 'font-family': UI_FONT, 'font-size': 13, 'font-weight': 600, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g)
    label.textContent = text
    return g
  }
  return { build, w, h }
}

/** The centre for a w×h piece beside `r`, kept on screen. */
export function beside(r: Rect, side: 'above' | 'below' | 'left' | 'right', w: number, h: number, gap = 16): Point {
  const c: Point =
    side === 'below' ? [r.x + r.w / 2, r.y + r.h + gap + h / 2]
    : side === 'left' ? [r.x - gap - w / 2, r.y + r.h / 2]
    : side === 'right' ? [r.x + r.w + gap + w / 2, r.y + r.h / 2]
    : [r.x + r.w / 2, r.y - gap - h / 2]
  return [clamp(c[0], w / 2 + 6, innerWidth - w / 2 - 6), clamp(c[1], h / 2 + 6, innerHeight - h / 2 - 6)]
}

