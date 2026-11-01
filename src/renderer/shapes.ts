// Geometry for hand-drawn marks, in screen points. Every shape is a pen path (a list of points) so the
// renderer can reveal it the way a pen would draw it. A little randomness keeps two rings from looking stamped.
import type { Point } from '../shared/marks'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const jitter = (amp: number) => (Math.random() * 2 - 1) * amp

export function lengthOf(pts: Point[]): number {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return len
}

/** The part of a polyline between arc lengths `from` and `to`, with interpolated ends. */
export function slice(pts: Point[], from: number, to: number): Point[] {
  const out: Point[] = []
  let walked = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1])
    const s0 = walked, s1 = walked + seg
    walked = s1
    if (s1 < from || seg === 0) continue
    if (s0 > to) break
    const at = (s: number): Point => {
      const t = (s - s0) / seg
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
    if (!out.length) out.push(at(Math.max(from, s0)))
    out.push(at(Math.min(to, s1)))
    if (s1 >= to) break
  }
  return out
}

/** A loop around a box: a superellipse (it hugs a rectangle's corners) that starts top-left and overshoots its start. */
export function ring(r: Rect): Point[] {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2
  const rx = r.w / 2 + 8 + Math.min(10, r.w * 0.05)
  const ry = r.h / 2 + 7 + Math.min(8, r.h * 0.1)
  const p = 2.6, n = 90
  const start = -Math.PI * 0.78 + jitter(0.15), sweep = Math.PI * 2 * 1.1
  const tilt = jitter(0.04), phase = Math.random() * 6
  const pts: Point[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = start + sweep * t
    const c = Math.cos(a), s = Math.sin(a)
    // drifting outward a little as it goes, so the overshoot passes outside the start instead of on top of it
    const k = 1 + t * 0.07 + 0.02 * Math.sin(a * 2 + phase)
    const x = Math.sign(c) * Math.abs(c) ** (2 / p) * rx * k
    const y = Math.sign(s) * Math.abs(s) ** (2 / p) * ry * k
    pts.push([cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt)])
  }
  return pts
}

function quad(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]
}

/** A shaft from `from` to `to` (bent by `bend`, -1..1) and a V-shaped head whose point is `to`. */
export function arrow(from: Point, to: Point, bend = 0): { shaft: Point[]; head: Point[] } {
  const dx = to[0] - from[0], dy = to[1] - from[1]
  const len = Math.hypot(dx, dy) || 1
  const c: Point = [(from[0] + to[0]) / 2 - (dy / len) * bend * len * 0.3, (from[1] + to[1]) / 2 + (dx / len) * bend * len * 0.3]
  const n = Math.max(8, Math.round(len / 8))
  const shaft = Array.from({ length: n + 1 }, (_, i) => quad(from, c, to, i / n))
  const end = shaft[Math.max(0, n - 2)]
  const angle = Math.atan2(to[1] - end[1], to[0] - end[0]) + Math.PI
  const size = Math.min(17, len * 0.35)
  const wing = (s: number): Point => [to[0] + Math.cos(angle + s * 0.5) * size, to[1] + Math.sin(angle + s * 0.5) * size]
  return { shaft, head: [wing(-1), to, wing(1)] }
}

export function underline(r: Rect): Point[] {
  const y = r.y + r.h + 4
  return arrow([r.x - 3, y + jitter(1)], [r.x + r.w + 5, y - 1.5 + jitter(1)], 0.04 + jitter(0.03)).shaft
}

/** A marker swipe across the middle of a box, inset so a nib `size` wide ends at the box's edges. */
export function marker(r: Rect, size: number): Point[] {
  const y = r.y + r.h / 2
  const x0 = r.x + Math.min(r.w / 2, size / 2 - 3), x1 = r.x + r.w - Math.min(r.w / 2, size / 2 - 3)
  const n = 16
  return Array.from({ length: n + 1 }, (_, i): Point => [x0 + ((x1 - x0) * i) / n, y + jitter(0.6) + (i / n) * jitter(1.5)])
}

/** The outline of a rounded rectangle, clockwise from the top-left, as dash-sized pen paths. */
export function dashes(r: Rect, dash = 11, gap = 7, radius = 10): Point[][] {
  const rad = Math.min(radius, r.w / 2, r.h / 2)
  const corners: [number, number, number][] = [
    [r.x + r.w - rad, r.y + rad, -Math.PI / 2],
    [r.x + r.w - rad, r.y + r.h - rad, 0],
    [r.x + rad, r.y + r.h - rad, Math.PI / 2],
    [r.x + rad, r.y + rad, Math.PI],
  ]
  const outline: Point[] = [[r.x + rad, r.y]]
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (Math.PI / 2) * (i / 6)
      outline.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad])
    }
  }
  outline.push([r.x + rad, r.y])
  const total = lengthOf(outline)
  const out: Point[][] = []
  for (let s = 0; s < total; s += dash + gap) out.push(slice(outline, s, Math.min(total, s + dash)))
  return out
}

/** An SVG path for a perfect-freehand outline polygon. */
export function outlinePath(outline: number[][]): string {
  if (outline.length < 4) return ''
  const avg = (a: number, b: number) => ((a + b) / 2).toFixed(2)
  let [a, b] = outline
  const c = outline[2]
  let d = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${avg(b[0], c[0])},${avg(b[1], c[1])} T`
  for (let i = 2; i < outline.length - 1; i++) {
    a = outline[i]
    b = outline[i + 1]
    d += `${avg(a[0], b[0])},${avg(a[1], b[1])} `
  }
  return d + 'Z'
}
