// The overlay page: turns marks into animated, hand-drawn SVG. Every mark becomes beats (a pen stroke, a pill
// popping in, a fade) and beats play one after another, so a drawing appears in the order the agent wrote it.
// Opened in a plain browser (no `window.inkBridge`) it draws the demo over a mock window instead.
import { getStroke } from 'perfect-freehand'
import { DEMO_CAPTION, DEMO_MARKS, DEMO_SIZE } from '../shared/demo'
import type { Box, DrawPayload, Mark, Point } from '../shared/marks'
import { arrow, dashes, lengthOf, marker, outlinePath, ring, slice, underline, type Rect } from './shapes'

declare global {
  interface Window {
    inkBridge?: { onDraw(cb: (p: DrawPayload) => void): void; onClear(cb: (o: { instant: boolean }) => void): void }
  }
}

const NS = 'http://www.w3.org/2000/svg'
const svg = document.getElementById('ink') as unknown as SVGSVGElement
const under = document.getElementById('under') as unknown as SVGGElement
const over = document.getElementById('over') as unknown as SVGGElement
const caption = document.getElementById('caption') as HTMLDivElement

const PEN = 4 // the pen's width in points
const GAP = 0.12 // seconds between marks
const UI_FONT = '-apple-system, "SF Pro Text", system-ui, sans-serif'
const HAND_FONT = '"Chalkboard SE", "Marker Felt", "Comic Sans MS", cursive'
const MARKER = '#FFE14D'

interface Beat {
  dur: number
  /** Start together with the beat before instead of after it. */
  together?: boolean
  start?: () => void
  frame: (t: number) => void
}
interface Scheduled extends Beat {
  at: number
  started?: boolean
}

let playing: Scheduled[] = []
let endsAt = 0
let raf = 0
let fadeTimer = 0
let generation = 0

const now = () => performance.now() / 1000
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const easePen = (t: number) => 0.5 - Math.cos(Math.PI * t) / 2
const easeBack = (t: number) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  parent?.append(e)
  return e
}

const measure = document.createElement('canvas').getContext('2d')!
function textWidth(text: string, font: string): number {
  measure.font = font
  return measure.measureText(text).width
}

function tick(): void {
  const t = now()
  for (const b of playing) {
    if (t < b.at) continue
    if (!b.started) {
      b.started = true
      b.start?.()
    }
    b.frame(clamp((t - b.at) / b.dur, 0, 1))
  }
  playing = playing.filter(b => t < b.at + b.dur)
  raf = playing.length ? requestAnimationFrame(tick) : 0
}

// ---- beats

function pen(g: Element, pts: Point[], color: string, o: { size?: number; opacity?: number; speed?: number } = {}): Beat {
  const len = lengthOf(pts)
  const size = o.size ?? PEN
  let path: SVGPathElement
  return {
    dur: clamp(len / (o.speed ?? 1000), 0.16, 0.9),
    start: () => (path = el('path', { fill: color, opacity: o.opacity ?? 1 }, g)),
    frame: t => {
      const part = slice(pts, 0, len * easePen(t))
      if (part.length < 2) return
      const outline = getStroke(part, { size, thinning: 0, smoothing: 0.6, streamline: 0.3, simulatePressure: false, last: t >= 1 })
      path.setAttribute('d', outlinePath(outline))
    },
  }
}

/** Pops a node built around the origin in at `center`. */
function pop(g: Element, build: () => SVGGElement, center: Point): Beat {
  let node: SVGGElement
  return {
    dur: 0.32,
    start: () => g.append((node = build())),
    frame: t => {
      node.setAttribute('transform', `translate(${center[0]} ${center[1]}) scale(${0.5 + 0.5 * easeBack(t)})`)
      node.setAttribute('opacity', String(clamp(t * 3, 0, 1)))
    },
  }
}

function fadeIn(g: Element, build: () => SVGElement, to = 1, dur = 0.35, together = false): Beat {
  let node: SVGElement
  return { dur, together, start: () => g.append((node = build())), frame: t => node.setAttribute('opacity', String(to * t)) }
}

// ---- pieces

function pill(text: string, color: string): { build: () => SVGGElement; w: number; h: number } {
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

function badge(n: string, color: string): () => SVGGElement {
  return () => {
    const g = el('g', {})
    el('circle', { r: 12, fill: color, stroke: '#FFFFFF', 'stroke-width': 2 }, g)
    const t = el('text', { fill: '#FFFFFF', 'font-family': UI_FONT, 'font-size': 13, 'font-weight': 700, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g)
    t.textContent = n
    return g
  }
}

/** The centre for a w×h piece beside `r`, kept on screen. */
function beside(r: Rect, side: 'above' | 'below' | 'left' | 'right', w: number, h: number, gap = 16): Point {
  const c: Point =
    side === 'below' ? [r.x + r.w / 2, r.y + r.h + gap + h / 2]
    : side === 'left' ? [r.x - gap - w / 2, r.y + r.h / 2]
    : side === 'right' ? [r.x + r.w + gap + w / 2, r.y + r.h / 2]
    : [r.x + r.w / 2, r.y - gap - h / 2]
  return [clamp(c[0], w / 2 + 6, innerWidth - w / 2 - 6), clamp(c[1], h / 2 + 6, innerHeight - h / 2 - 6)]
}

let maskId = 0

function beatsFor(m: Mark, g: SVGGElement, color: string, P: (p: Point) => Point, R: (b: Box) => Rect): Beat[] {
  switch (m.kind) {
    case 'ring':
      return [pen(g, ring(R(m.box as Box)), color, { speed: 1300 })]
    case 'arrow': {
      const { shaft, head } = arrow(P(m.from as Point), P(m.to as Point), m.bend)
      return [pen(g, shaft, color, { speed: 1200 }), pen(g, head, color, { speed: 500 })]
    }
    case 'label': {
      const p = pill(m.text, color)
      const target = m.box ? R(m.box as Box) : m.at ? toRect(P(m.at as Point)) : null
      if (!target) return []
      return [pop(g, p.build, beside(target, m.side ?? 'above', p.w, p.h, m.box ? 16 : 8))]
    }
    case 'badge':
      return [pop(g, badge(String(m.n), color), P(m.at as Point))]
    case 'frame': {
      const r = R(m.box as Box)
      const segs = dashes(r).map(d => outlinePath(getStroke(d, { size: 3, thinning: 0, simulatePressure: false, last: true })))
      let paths: SVGPathElement[] = []
      const beats: Beat[] = [
        {
          dur: clamp((2 * (r.w + r.h)) / 1500, 0.4, 1.1),
          start: () => (paths = segs.map(d => el('path', { d, fill: color, opacity: 0 }, g))),
          frame: t => paths.forEach((p, i) => p.setAttribute('opacity', i < t * paths.length ? '1' : '0')),
        },
        fadeIn(g, () => el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 10, fill: color, opacity: 0 }), 0.08, 0.5, true),
      ]
      if (m.text) {
        const p = pill(m.text, color)
        beats.push(pop(g, p.build, [clamp(r.x + p.w / 2, p.w / 2 + 6, innerWidth - p.w / 2 - 6), Math.max(p.h / 2 + 6, r.y - 6 - p.h / 2)]))
      }
      return beats
    }
    case 'underline':
      return [pen(g, underline(R(m.box as Box)), color, { speed: 900 })]
    case 'highlight': {
      const r = R(m.box as Box)
      return [pen(g, marker(r, r.h + 2), m.color ?? MARKER, { size: r.h + 2, opacity: 0.4, speed: 700 })]
    }
    case 'text': {
      const [x, y] = P(m.at as Point)
      const size = m.size ?? 20
      const lines = m.text.split('\n')
      const chars = m.text.length
      let spans: SVGTSpanElement[] = []
      return [
        {
          dur: clamp(chars * 0.035, 0.3, 1.6),
          start: () => {
            const t = el('text', { x, y, fill: color, 'font-family': HAND_FONT, 'font-size': size, 'dominant-baseline': 'hanging' }, g)
            spans = lines.map((_, i) => el('tspan', { x, dy: i ? size * 1.2 : 0 }, t))
          },
          frame: t => {
            let left = Math.round(chars * t)
            lines.forEach((line, i) => {
              spans[i].textContent = line.slice(0, Math.max(0, left))
              left -= line.length + 1
            })
          },
        },
      ]
    }
    case 'line':
      return [pen(g, (m.points as Point[]).map(P), color)]
    case 'spotlight': {
      const r = R(m.box as Box)
      const id = `spot${++maskId}`
      return [
        fadeIn(g, () => {
          const s = el('g', {})
          const mask = el('mask', { id }, s)
          el('rect', { width: '100%', height: '100%', fill: '#FFFFFF' }, mask)
          el('rect', { x: r.x - 8, y: r.y - 8, width: r.w + 16, height: r.h + 16, rx: 12, fill: '#000000' }, mask)
          el('rect', { width: '100%', height: '100%', fill: '#000000', opacity: 0.5, mask: `url(#${id})` }, s)
          return s
        }),
      ]
    }
  }
}

const toRect = ([x, y]: Point): Rect => ({ x, y, w: 0, h: 0 })

// ---- drawing and clearing

function wipe(): void {
  playing = []
  endsAt = 0
  clearTimeout(fadeTimer)
  under.replaceChildren()
  over.replaceChildren()
  caption.classList.remove('show')
  svg.style.transition = ''
  svg.style.opacity = '1'
}

function clearInk(instant: boolean): void {
  const gen = ++generation
  if (instant) return wipe()
  svg.style.transition = 'opacity .3s'
  svg.style.opacity = '0'
  caption.classList.remove('show')
  setTimeout(() => gen === generation && wipe(), 320)
}

function draw(p: DrawPayload): void {
  generation++
  if (!p.append) wipe()
  clearTimeout(fadeTimer)
  svg.style.transition = ''
  svg.style.opacity = '1'

  const P = (q: Point): Point => [q[0] * p.ppu, q[1] * p.ppu]
  const R = (b: Box): Rect => ({ x: b[0] * p.ppu, y: b[1] * p.ppu, w: b[2] * p.ppu, h: b[3] * p.ppu })
  let cursor = Math.max(now(), endsAt) + 0.05
  for (const m of p.marks) {
    const color = (m.kind !== 'spotlight' && m.color) || p.ink
    const flat = m.kind === 'highlight' || m.kind === 'spotlight'
    const g = el('g', flat ? {} : { style: `filter: drop-shadow(0 0 5px ${color}99) drop-shadow(0 1px 1.5px rgba(0,0,0,.35))` }, m.kind === 'spotlight' ? under : over)
    cursor += m.delay ?? 0
    let prevAt = cursor
    for (const b of beatsFor(m, g, color, P, R)) {
      const at = b.together ? prevAt : cursor
      playing.push({ ...b, at })
      prevAt = at
      cursor = Math.max(cursor, at + b.dur)
    }
    cursor += GAP
  }
  endsAt = cursor

  if (p.caption) {
    caption.textContent = p.caption
    caption.classList.add('show')
  }
  if (p.fadeAfter) fadeTimer = window.setTimeout(() => clearInk(false), (cursor - now() + p.fadeAfter) * 1000)
  if (!raf) raf = requestAnimationFrame(tick)
}

if (window.inkBridge) {
  window.inkBridge.onDraw(draw)
  window.inkBridge.onClear(o => clearInk(o.instant))
} else {
  document.body.classList.add('preview')
  const mock = document.getElementById('mock') as HTMLDivElement
  const run = () => {
    const ppu = innerWidth / DEMO_SIZE.width
    mock.style.transform = `scale(${ppu})`
    draw({ marks: DEMO_MARKS, caption: DEMO_CAPTION, ppu, ink: '#FF5A36' })
  }
  addEventListener('resize', run)
  addEventListener('keydown', e => e.key === 'r' && run())
  document.getElementById('replay')?.addEventListener('click', run)
  run()
}
