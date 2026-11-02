// The overlay page: turns marks into animated, hand-drawn SVG. Every mark becomes beats (a pen stroke, a pill
// popping in, a fade) and beats play one after another, so a drawing appears in the order the agent wrote it.
// A mark's `say` is spoken as it starts, and the drawing waits at the mark's end until the words are out.
// Opened in a plain browser (no `window.inkBridge`) it draws the demo over a mock window instead.
import { getStroke } from 'perfect-freehand'
import { speaksCaption } from '../shared/caption'
import { DEMO_CAPTION, DEMO_FIGURE_CAPTION, DEMO_FIGURE_MARKS, DEMO_MARKS, DEMO_SIZE } from '../shared/demo'
import type { Box, DrawPayload, Mark, Point } from '../shared/marks'
import { actionBeats, codeBeats, mathBeats, noteBeats, photoBeats, stepsBeats, type Act, type CardHooks, type Outcome, type Place } from './cards'
import { flowBeats, plotBeats, timelineBeats } from './charts'
import { clamp, el, now, UI_FONT, type Beat } from './common'
import { disposeFigures, figureBeats } from './figure'
import { beside, fadeIn, HAND_FONT, pen, pill, pop } from './ink'
import { arrow, connector, cross, dashes, marker, outlinePath, ring, strike, tick as tickMark, underline, type Rect } from './shapes'
import * as pointer from './pointer'
import { setSounds } from './sounds'

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
      act(what: Act, value: string, folder?: string): Promise<Outcome>
      onPoint(cb: (p: { id: number; at: Point; press?: boolean; label?: string; scroll?: 'down' | 'up' | 'right' | 'left' }) => void): void
      pointed(id: number): void
    }
  }
}

const svg = document.getElementById('ink') as unknown as SVGSVGElement
const under = document.getElementById('under') as unknown as SVGGElement
const over = document.getElementById('over') as unknown as SVGGElement
const cards = document.getElementById('cards') as HTMLDivElement
const caption = document.getElementById('caption') as HTMLDivElement
const subtitle = document.getElementById('subtitle') as HTMLDivElement

const GAP = 0.12 // seconds between marks
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

function badge(n: string, color: string): () => SVGGElement {
  return () => {
    const g = el('g', {})
    el('circle', { r: 12, fill: color, stroke: '#FFFFFF', 'stroke-width': 2 }, g)
    const t = el('text', { fill: '#FFFFFF', 'font-family': UI_FONT, 'font-size': 13, 'font-weight': 700, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g)
    t.textContent = n
    return g
  }
}

let maskId = 0

function dot(color: string): () => SVGGElement {
  return () => {
    const d = el('g', {})
    el('circle', { r: 4.5, fill: color }, d)
    return d
  }
}

/** A mark's beats. SVG goes in `g`; HTML cards go in `host`. */
function beatsFor(m: Mark, g: SVGGElement, host: HTMLElement, color: string, P: (p: Point) => Point, R: (b: Box) => Rect): Beat[] {
  const at: Place = { P, R }
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
      return figureBeats(m, R(m.box as Box), color, host, figureHooks)
    case 'check':
      return [pen(g, tickMark(P(m.at as Point)), color, { speed: 500 })]
    case 'cross':
      return cross(P(m.at as Point)).map(stroke => pen(g, stroke, color, { speed: 500 }))
    case 'strike':
      return [pen(g, strike(R(m.box as Box)), color, { speed: 900 })]
    case 'connect': {
      const line = connector(R(m.from as Box), R(m.to as Box))
      const beats = [pop(g, dot(color), line[0]), pen(g, line, color, { speed: 1200 }), pop(g, dot(color), line[line.length - 1])]
      if (m.text) beats.push(pop(g, pill(m.text, color).build, line[Math.floor(line.length / 2)]))
      return beats
    }
    case 'note':
      return noteBeats(m, color, host, at)
    case 'steps':
      return stepsBeats(m, color, host, at)
    case 'code':
      return codeBeats(m, color, host, at, cardHooks)
    case 'math':
      return mathBeats(m, color, host, at)
    case 'photo':
      return photoBeats(m, color, host, at, cardHooks)
    case 'action':
      return actionBeats(m, color, host, at, cardHooks)
    case 'plot':
      return plotBeats(m, g, color, R)
    case 'timeline':
      return timelineBeats(m, g, color, R)
    case 'flow':
      return flowBeats(m, g, color, R)
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
  named.clear()
  under.replaceChildren()
  over.replaceChildren()
  cards.replaceChildren()
  caption.classList.remove('show')
  stopSaying()
  fade(false)
}

function clearInk(instant: boolean): void {
  const gen = ++generation
  pointer.hide(instant)
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

/** A button on a card was clicked. The browser preview only copies. */
const cardHooks: CardHooks = {
  act: async (what, value, folder) => {
    if (window.inkBridge) return window.inkBridge.act(what, value, folder)
    if (what !== 'copy') return null
    await navigator.clipboard.writeText(value)
    return 'done'
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
  const over = !!document.querySelector('.card.dragging') || !!document.elementFromPoint(e.clientX, e.clientY)?.closest('.card, .interactive')
  if (over === overCard) return
  overCard = over
  window.inkBridge?.pointer(over)
  if (over) clearTimeout(fadeTimer)
  else if (fadeAfter) fadeLater(fadeAfter)
}

// Marks with ids, so a later drawing can replace or remove them.
const named = new Map<string, { g: Element; host: HTMLElement }>()

function drop(mark: { g: Element; host: HTMLElement }): void {
  mark.g.remove()
  disposeFigures(mark.host)
  mark.host.remove()
}

function draw(p: DrawPayload): void {
  generation++
  if (!p.append) wipe()
  pointer.enter(p.ink, p.cursor !== false, !p.append, p.mouse)
  setSounds(p.sounds ?? false)
  for (const id of p.remove ?? []) {
    const old = named.get(id)
    if (old) drop(old)
    named.delete(id)
  }
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
    const flat = ['highlight', 'spotlight', 'plot', 'timeline', 'flow'].includes(m.kind)
    const g = el('g', flat ? {} : { style: `filter: drop-shadow(0 0 5px ${color}99) drop-shadow(0 1px 1.5px rgba(0,0,0,.35))` }, m.kind === 'spotlight' ? under : over)
    const host = document.createElement('div')
    cards.append(host)
    cursor += m.delay ?? 0
    const from = cursor
    // The pointer goes to each mark as it starts, but stays on a step's target while its own button pops in.
    const aim = m.id === 'walk' ? null : pointer.aim(m, P, R)
    if (aim) playing.push({ at: from, dur: 0, frame: () => {}, start: () => void pointer.glide(aim) })
    if (m.id) {
      // A mark with an id an earlier one had takes its place as it starts.
      const old = named.get(m.id)
      named.set(m.id, { g, host })
      if (old) playing.push({ at: from, dur: 0, frame: () => {}, start: () => drop(old) })
    }
    let prevAt = cursor
    let said = !m.say
    for (const b of beatsFor(m, g, host, color, P, R)) {
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
  window.inkBridge.onPoint(async p => {
    await (p.press ? pointer.press(p.at, p.label) : p.scroll ? pointer.scroll(p.at, p.scroll) : pointer.glide(p.at))
    window.inkBridge!.pointed(p.id)
  })
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
  // For trying a drawing out from the console: drawPreview(marks, caption, { append, remove, … }), and the pointer's
  // press and scroll: pressPreview([x, y], 'View'), scrollPreview([x, y], 'down').
  Object.assign(window, {
    drawPreview: (marks: Mark[], text?: string, more: Partial<DrawPayload> = {}) =>
      draw({ marks, caption: text, ppu: innerWidth / DEMO_SIZE.width, ink: '#FF5A36', ...more }),
    pressPreview: (at: Point, label?: string) => pointer.press(at, label),
    scrollPreview: (at: Point, direction: 'down' | 'up' | 'right' | 'left' = 'down') => pointer.scroll(at, direction),
  })
  addEventListener('resize', run)
  addEventListener('keydown', e => (e.key === 'r' ? run() : e.key === '3' ? pick(true)() : e.key === '2' ? pick(false)() : null))
  document.getElementById('replay')?.addEventListener('click', pick(false))
  document.getElementById('replay3d')?.addEventListener('click', pick(true))
  run()
}
