// The overlay page: turns marks into animated, hand-drawn SVG. Every mark becomes beats (a pen stroke, a pill
// popping in, a fade) and beats play one after another, so a drawing appears in the order the agent wrote it.
// A mark's `say` is spoken as it starts, and the drawing waits at the mark's end until the words are out.
// Opened in a plain browser (no `window.inkBridge`) it draws the demo over a mock window instead.
import { getStroke } from 'perfect-freehand'
import { speaksCaption } from '../shared/caption'
import { DEMO_CAPTION, DEMO_FIGURE_CAPTION, DEMO_FIGURE_MARKS, DEMO_MARKS, DEMO_SIZE } from '../shared/demo'
import type { Box, DrawPayload, Mark, Point } from '../shared/marks'
import { clamp, easeBack, easePen, el, now, textWidth, UI_FONT, type Beat } from './common'
import { disposeFigures, figureBeats } from './figure'
import { arrow, dashes, lengthOf, marker, outlinePath, ring, slice, underline, type Rect } from './shapes'

declare global {
  interface Window {
    inkBridge?: {
      onDraw(cb: (p: DrawPayload) => void): void
      onClear(cb: (o: { instant: boolean }) => void): void
      speak(text: string): Promise<void>
      onSaying(cb: (s: { text: string; seconds: number }) => void): void
      pointer(over: boolean): void
      ask(question: string): void
      save(name: string, usdz: Uint8Array): Promise<string | null>
    }
  }
}

const svg = document.getElementById('ink') as unknown as SVGSVGElement
const under = document.getElementById('under') as unknown as SVGGElement
const over = document.getElementById('over') as unknown as SVGGElement
const cards = document.getElementById('cards') as HTMLDivElement
const caption = document.getElementById('caption') as HTMLDivElement
const subtitle = document.getElementById('subtitle') as HTMLDivElement

const PEN = 4 // the pen's width in points
const GAP = 0.12 // seconds between marks
const HAND_FONT = '"Chalkboard SE", "Marker Felt", "Comic Sans MS", cursive'
const MARKER = '#FFE14D'
const LONGEST_WORDS = 30 // seconds a mark waits for its words at most

interface Scheduled extends Beat {
  at: number
  started?: boolean
  /** Starts the fade-out countdown; a new drawing drops it. */
  fades?: boolean
}

let playing: Scheduled[] = []
let endsAt = 0
let raf = 0
let fadeTimer = 0
let fadeAfter = 0 // seconds, once the current drawing's fade-out has been set going
let generation = 0

// Beats run on a drawing clock: real time, except that it stops while a mark waits for its words.
let clockAt = 0
let realAt = now()
let waiting: Promise<void> | null = null

function clock(): number {
  const t = now()
  if (!waiting) clockAt += t - realAt
  realAt = t
  return clockAt
}

function speak(text: string): Promise<void> {
  if (window.inkBridge) return window.inkBridge.speak(text)
  // The browser preview has no voice: it captions the words at speaking pace instead.
  const seconds = text.split(/\s+/).length / 2.9
  showSaying(text, seconds)
  return new Promise(r => setTimeout(r, seconds * 1000))
}

// ---- captions: the line being said, each word lighting up in turn

let saying = ''
let wordTimers: number[] = []
let hideTimer = 0

function showSaying(text: string, seconds: number): void {
  if (caption.classList.contains('show') && caption.textContent === text) return // the caption is what's being read
  wordTimers.forEach(clearTimeout)
  clearTimeout(hideTimer)
  saying = text
  const words = text.split(/\s+/).filter(Boolean)
  // A word takes time by its length, and a little more where the voice pauses after it.
  const weight = (w: string) => w.length + 1 + (/[.!?]$/.test(w) ? 5 : /[,;:]$/.test(w) ? 3 : 0)
  const total = words.reduce((sum, w) => sum + weight(w), 0)
  let at = 0
  subtitle.replaceChildren(
    ...words.map((w, i) => {
      const span = document.createElement('span')
      span.textContent = i < words.length - 1 ? `${w} ` : w
      wordTimers.push(window.setTimeout(() => span.classList.add('said'), (at / total) * seconds * 1000))
      at += weight(w)
      return span
    }),
  )
  subtitle.classList.add('show')
}

/** The line is out: take it down, unless the next one comes first. */
function doneSaying(text: string): void {
  if (saying !== text) return
  clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => {
    saying = ''
    subtitle.classList.remove('show')
  }, 700)
}

function stopSaying(): void {
  wordTimers.forEach(clearTimeout)
  wordTimers = []
  clearTimeout(hideTimer)
  saying = ''
  subtitle.classList.remove('show')
}

/** Speaks `text` at `from` and holds the clock at `to` until it has been said. */
function narrate(text: string, from: number, to: number): void {
  let said: Promise<unknown> = Promise.resolve()
  const quiet = () => {}
  playing.push(
    {
      at: from,
      dur: 0,
      frame: quiet,
      start: () => (said = Promise.race([speak(text), new Promise(r => setTimeout(r, LONGEST_WORDS * 1000))]).finally(() => doneSaying(text))),
    },
    {
      at: to,
      dur: 0,
      frame: quiet,
      start: () => {
        clock()
        const w = (waiting = said.then(() => {
          if (waiting !== w) return
          clock()
          waiting = null
        }))
      },
    },
  )
}

function tick(): void {
  const t = clock()
  for (const b of playing) {
    if (t < b.at) continue
    if (!b.started) {
      if (waiting) continue // a mark is still being said: nothing new starts, even what is due this frame
      b.started = true
      b.start?.()
    }
    b.frame(clamp((t - b.at) / b.dur, 0, 1))
  }
  playing = playing.filter(b => !b.started || t < b.at + b.dur)
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
    case 'figure':
      return figureBeats(m, R(m.box as Box), color, cards, figureHooks)
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

function fade(out: boolean): void {
  for (const layer of [svg, cards]) {
    layer.style.transition = out ? 'opacity .3s' : ''
    layer.style.opacity = out ? '0' : '1'
  }
}

function wipe(): void {
  playing = []
  endsAt = 0
  waiting = null
  clearTimeout(fadeTimer)
  fadeAfter = 0
  if (overCard) {
    overCard = false
    window.inkBridge?.pointer(false) // its card is gone: let clicks through again
  }
  disposeFigures()
  under.replaceChildren()
  over.replaceChildren()
  cards.replaceChildren()
  caption.classList.remove('show')
  stopSaying()
  fade(false)
}

function clearInk(instant: boolean): void {
  const gen = ++generation
  if (instant) return wipe()
  fade(true)
  caption.classList.remove('show')
  stopSaying()
  setTimeout(() => gen === generation && wipe(), 320)
}

/** A part of a figure was clicked. The browser preview shows the question instead of asking it. */
const figureHooks = {
  ask,
  say: (text: string) => Promise.race([speak(text), new Promise(r => setTimeout(r, LONGEST_WORDS * 1000))]).finally(() => doneSaying(text)),
  save: async (name: string, usdz: Uint8Array) => {
    if (window.inkBridge) return window.inkBridge.save(name, usdz)
    // The browser preview downloads it.
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([usdz as BlobPart], { type: 'model/vnd.usdz+zip' }))
    a.download = `${name}.usdz`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  },
}

function ask(question: string): void {
  if (window.inkBridge) return window.inkBridge.ask(question)
  caption.textContent = question
  caption.classList.add('show')
}

function fadeLater(seconds: number): void {
  clearTimeout(fadeTimer)
  fadeTimer = window.setTimeout(() => clearInk(false), seconds * 1000)
}

// The window lets clicks through to the apps below, except over a figure's card, which the user can turn and click.
// While the mouse is on a card the drawing doesn't fade.
let overCard = false
function trackPointer(e: MouseEvent): void {
  const over = !!document.querySelector('.card.dragging') || !!document.elementFromPoint(e.clientX, e.clientY)?.closest('.card')
  if (over === overCard) return
  overCard = over
  window.inkBridge?.pointer(over)
  if (over) clearTimeout(fadeTimer)
  else if (fadeAfter) fadeLater(fadeAfter)
}

function draw(p: DrawPayload): void {
  generation++
  if (!p.append) wipe()
  clearTimeout(fadeTimer)
  fadeAfter = 0
  playing = playing.filter(b => !b.fades)
  fade(false)

  const P = (q: Point): Point => [q[0] * p.ppu, q[1] * p.ppu]
  const R = (b: Box): Rect => ({ x: b[0] * p.ppu, y: b[1] * p.ppu, w: b[2] * p.ppu, h: b[3] * p.ppu })
  const start = Math.max(clock(), endsAt) + 0.05
  let cursor = start
  for (const m of p.marks) {
    const color = (m.kind !== 'spotlight' && m.color) || p.ink
    const flat = m.kind === 'highlight' || m.kind === 'spotlight'
    const g = el('g', flat ? {} : { style: `filter: drop-shadow(0 0 5px ${color}99) drop-shadow(0 1px 1.5px rgba(0,0,0,.35))` }, m.kind === 'spotlight' ? under : over)
    cursor += m.delay ?? 0
    const from = cursor
    let prevAt = cursor
    let said = !m.say
    for (const b of beatsFor(m, g, color, P, R)) {
      const at = b.together ? prevAt : cursor
      if (b.say) {
        // A beat with words of its own (a figure's step) starts once the mark's words are out, and says its own.
        if (!said) narrate(m.say!, from, at)
        said = true
        narrate(b.say, at, at + b.dur)
      }
      playing.push({ ...b, at })
      prevAt = at
      cursor = Math.max(cursor, at + b.dur)
    }
    if (!said) narrate(m.say!, from, cursor)
    cursor += GAP
  }
  // Nothing narrated: read the caption out over the whole drawing instead.
  if (speaksCaption(p)) narrate(p.caption!, start, cursor)
  endsAt = cursor
  // In time order, so when a slow frame finds several beats due, a beat starts before a later wait for words can
  // hold it back (the sort keeps the order of beats due together).
  playing.sort((a, b) => a.at - b.at)

  if (p.caption) {
    caption.textContent = p.caption
    caption.classList.add('show')
  }
  const after = p.fadeAfter
  if (after) playing.push({ at: cursor, dur: 0, fades: true, frame: () => {}, start: () => fadeLater((fadeAfter = after)) })
  if (!raf) raf = requestAnimationFrame(tick)
}

if (window.inkBridge) {
  window.inkBridge.onDraw(draw)
  window.inkBridge.onClear(o => clearInk(o.instant))
  window.inkBridge.onSaying(s => showSaying(s.text, s.seconds))
  document.addEventListener('mousemove', trackPointer)
} else {
  document.body.classList.add('preview')
  const mock = document.getElementById('mock') as HTMLDivElement
  let figureDemo = location.hash === '#3d'
  const run = () => {
    const ppu = innerWidth / DEMO_SIZE.width
    mock.style.transform = `scale(${ppu})`
    if (figureDemo) draw({ marks: DEMO_FIGURE_MARKS, caption: DEMO_FIGURE_CAPTION, ppu, ink: '#FF5A36' })
    else draw({ marks: DEMO_MARKS, caption: DEMO_CAPTION, ppu, ink: '#FF5A36' })
  }
  const pick = (figure: boolean) => () => {
    figureDemo = figure
    run()
  }
  // For trying a drawing out from the console: drawPreview(marks, caption).
  Object.assign(window, { drawPreview: (marks: Mark[], text?: string) => draw({ marks, caption: text, ppu: innerWidth / DEMO_SIZE.width, ink: '#FF5A36' }) })
  addEventListener('resize', run)
  addEventListener('keydown', e => (e.key === 'r' ? run() : e.key === '3' ? pick(true)() : e.key === '2' ? pick(false)() : null))
  document.getElementById('replay')?.addEventListener('click', pick(false))
  document.getElementById('replay3d')?.addEventListener('click', pick(true))
  run()
}
