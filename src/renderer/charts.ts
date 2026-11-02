// Charts drawn by hand on a card: a plot of lines or bars with axes scaled to the data, a timeline, and a flowchart
// that lays itself out in rows (or columns) so its arrows mostly run one way.
import type { Box, Mark, Point } from '../shared/marks'
import { clamp, el, textWidth, UI_FONT, type Beat } from './common'
import { fadeIn, pen, pop } from './ink'
import { arrow, box as boxPath, dense, diamond, exit, type Rect } from './shapes'

type Of<K extends Mark['kind']> = Extract<Mark, { kind: K }>

const PAPER = '#FBF8F2'
const INK = '#30333A'
const MUTED = '#6B6F76'
const SERIES = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B']
const TITLE_H = 34

/** The card a chart is drawn on, with its title. */
function paper(g: SVGGElement, r: Rect, color: string, title?: string): Beat[] {
  const beats = [
    fadeIn(g, () => el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 14, fill: PAPER, style: 'filter: drop-shadow(0 10px 28px rgba(0,0,0,.26))' }), 1, 0.3),
  ]
  if (title) {
    const w = textWidth(title, `600 13px ${UI_FONT}`) + 24
    beats.push(
      pop(
        g,
        () => {
          const t = el('g', {})
          el('rect', { x: -w / 2, y: -12, width: w, height: 24, rx: 12, fill: color }, t)
          el('text', { fill: '#FFFFFF', 'font-family': UI_FONT, 'font-size': 13, 'font-weight': 600, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, t).textContent = title
          return t
        },
        [r.x + 12 + w / 2, r.y + 20],
      ),
    )
  }
  return beats
}

function words(g: SVGGElement, text: string, x: number, y: number, o: { size?: number; weight?: number; fill?: string; anchor?: string; rotate?: boolean } = {}): Beat {
  return fadeIn(
    g,
    () => {
      const t = el('text', {
        x,
        y,
        fill: o.fill ?? MUTED,
        'font-family': UI_FONT,
        'font-size': o.size ?? 11,
        'font-weight': o.weight ?? 500,
        'text-anchor': o.anchor ?? 'middle',
        'dominant-baseline': 'central',
        ...(o.rotate ? { transform: `rotate(-90 ${x} ${y})` } : {}),
      })
      t.textContent = text
      return t
    },
    1,
    0.25,
    true,
  )
}

/** Lines of at most `max` points wide. */
function wrap(text: string, max: number, font: string): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (line && textWidth(next, font) > max) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

/** About five round steps across [lo, hi]. */
function ticks(lo: number, hi: number): number[] {
  if (hi === lo) hi = lo + 1
  const raw = (hi - lo) / 5
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw) ?? raw
  const out: number[] = []
  // From the step at or below lo to the one at or above hi, so the data stays inside.
  const end = Math.ceil(hi / step - 1e-9) * step
  for (let v = Math.floor(lo / step + 1e-9) * step; v <= end + step * 1e-6; v += step) out.push(+v.toPrecision(12))
  return out
}

const short = (v: number) =>
  Math.abs(v) >= 1e9 ? `${+(v / 1e9).toPrecision(3)}B` : Math.abs(v) >= 1e6 ? `${+(v / 1e6).toPrecision(3)}M` : Math.abs(v) >= 1e4 ? `${+(v / 1e3).toPrecision(3)}k` : String(+v.toPrecision(4))

export function plotBeats(m: Of<'plot'>, g: SVGGElement, color: string, R: (b: Box) => Rect): Beat[] {
  const r = R(m.box as Box)
  const beats = paper(g, r, color, m.title)
  const bars = m.bars ?? []
  const series = m.series ?? []
  const plot = { x: r.x + (m.y ? 62 : 48), y: r.y + (m.title ? TITLE_H + 14 : 18), w: 0, h: 0 }
  plot.w = r.x + r.w - 18 - plot.x
  plot.h = r.y + r.h - (m.x ? 46 : 32) - plot.y
  if (plot.w < 40 || plot.h < 40) return beats

  // Bars start from zero; lines from the data's own range, a little padded.
  const ys = bars.length ? [0, ...bars.map(b => b.value)] : series.flatMap(s => s.points.map(p => p[1]))
  const pad = bars.length ? 0 : (Math.max(...ys) - Math.min(...ys)) * 0.06
  const yt = ticks(Math.min(...ys) - pad, Math.max(...ys) + pad)
  const y0 = yt[0], y1 = yt[yt.length - 1]
  const Y = (v: number) => plot.y + plot.h - ((v - y0) / (y1 - y0 || 1)) * plot.h
  const xs = series.flatMap(s => s.points.map(p => p[0]))
  const xt = bars.length ? [] : ticks(Math.min(...xs), Math.max(...xs))
  const x0 = xt[0] ?? 0, x1 = xt[xt.length - 1] ?? 1
  const X = (v: number) => plot.x + ((v - x0) / (x1 - x0 || 1)) * plot.w

  // Axes, then the scale.
  beats.push(pen(g, dense([[plot.x, plot.y - 4], [plot.x, plot.y + plot.h], [plot.x + plot.w + 4, plot.y + plot.h]]), INK, { size: 2.2, speed: 1400 }))
  for (const v of yt) {
    beats.push(words(g, short(v), plot.x - 8, Y(v), { anchor: 'end' }))
    if (v !== y0) beats.push(fadeIn(g, () => el('line', { x1: plot.x, x2: plot.x + plot.w, y1: Y(v), y2: Y(v), stroke: INK, 'stroke-opacity': 0.08 }), 1, 0.2, true))
  }
  for (const v of xt) beats.push(words(g, short(v), X(v), plot.y + plot.h + 14))
  if (m.x) beats.push(words(g, m.x, plot.x + plot.w / 2, r.y + r.h - 14, { fill: INK, weight: 600 }))
  if (m.y) beats.push(words(g, m.y, r.x + 16, plot.y + plot.h / 2, { fill: INK, weight: 600, rotate: true }))

  if (bars.length) {
    const slot = plot.w / bars.length
    const w = Math.min(46, slot * 0.62)
    bars.forEach((b, i) => {
      const cx = plot.x + slot * (i + 0.5)
      const top = Y(Math.max(0, b.value)), base = Y(Math.min(0, b.value))
      let rect: SVGRectElement
      beats.push({
        dur: 0.28,
        start: () => (rect = el('rect', { x: cx - w / 2, width: w, rx: 3, fill: color, 'fill-opacity': 0.85 }, g)),
        frame: t => {
          const h = (base - top) * t
          rect.setAttribute('y', String(b.value >= 0 ? base - h : base))
          rect.setAttribute('height', String(h))
        },
      })
      beats.push(words(g, b.label, cx, plot.y + plot.h + 14, { size: bars.length > 8 ? 9 : 11 }))
      beats.push(words(g, short(b.value), cx, top - 10, { fill: INK, weight: 600 }))
    })
  }
  series.forEach((s, i) => {
    const c = s.color ?? (series.length === 1 ? color : SERIES[i % SERIES.length])
    const pts = [...s.points].sort((a, b) => a[0] - b[0]).map(([x, y]): Point => [X(x), Y(y)])
    beats.push(pen(g, dense(pts), c, { size: 3, speed: 700 }))
    if (s.name && series.length > 1) {
      const lx = plot.x + plot.w - 8, ly = plot.y + 8 + i * 16
      beats.push(fadeIn(g, () => el('circle', { cx: lx - textWidth(s.name!, `500 11px ${UI_FONT}`) - 10, cy: ly, r: 4, fill: c }), 1, 0.2, true))
      beats.push(words(g, s.name, lx, ly, { anchor: 'end', fill: INK }))
    }
  })
  return beats
}

export function timelineBeats(m: Of<'timeline'>, g: SVGGElement, color: string, R: (b: Box) => Rect): Beat[] {
  const r = R(m.box as Box)
  const beats = paper(g, r, color, m.title)
  const top = r.y + (m.title ? TITLE_H : 0)
  const y = top + (r.y + r.h - top) / 2
  const x0 = r.x + 34, x1 = r.x + r.w - 34
  beats.push(pen(g, dense([[x0 - 14, y], [x1 + 14, y]]), INK, { size: 2.6, speed: 1500 }))
  const n = m.events.length
  const step = (x1 - x0) / Math.max(1, n - 1)
  // Crowded, the words alternate above and below the line.
  const alternate = n > 4
  const room = (alternate ? step * 2 : step) - 10
  const font = `500 12px ${UI_FONT}`
  m.events.forEach((e, i) => {
    const x = n === 1 ? (x0 + x1) / 2 : x0 + step * i
    const up = alternate && i % 2 === 1
    beats.push(
      pop(
        g,
        () => {
          const d = el('g', {})
          el('circle', { r: 6, fill: color, stroke: PAPER, 'stroke-width': 2 }, d)
          return d
        },
        [x, y],
      ),
    )
    const lines = wrap(e.text, clamp(room, 60, 180), font).slice(0, 3)
    const dir = up ? -1 : 1
    beats.push(words(g, e.when, x, y + dir * 18, { fill: color, weight: 700, size: 12 }))
    lines.forEach((line, k) => beats.push(words(g, line, x, y + dir * (36 + (up ? lines.length - 1 - k : k) * 15), { fill: INK, size: 12 })))
  })
  return beats
}

interface Node {
  id: string
  text: string
  shape: 'box' | 'round' | 'diamond'
  lines: string[]
  w: number
  h: number
  layer: number
  order: number
  x: number
  y: number
}

const NODE_FONT = `500 13px ${UI_FONT}`

export function flowBeats(m: Of<'flow'>, g: SVGGElement, color: string, R: (b: Box) => Rect): Beat[] {
  const r = R(m.box as Box)
  const beats = paper(g, r, color, m.title)
  const across = m.direction === 'right'
  const nodes = new Map<string, Node>()
  for (const n of m.nodes) {
    if (nodes.has(n.id)) continue
    const shape = n.shape ?? 'box'
    const lines = wrap(n.text, 150, NODE_FONT)
    const tw = Math.max(...lines.map(l => textWidth(l, NODE_FONT)))
    const w = tw + (shape === 'diamond' ? 56 : 28), h = lines.length * 17 + (shape === 'diamond' ? 34 : 18)
    nodes.set(n.id, { id: n.id, text: n.text, shape, lines, w, h, layer: 0, order: 0, x: 0, y: 0 })
  }
  const edges = m.edges.filter(e => nodes.has(e.from) && nodes.has(e.to) && e.from !== e.to)

  // Layers: each node one past the furthest node leading to it, taking the edges in an order that skips loops.
  const into = new Map<string, number>([...nodes.keys()].map(k => [k, 0]))
  for (const e of edges) into.set(e.to, into.get(e.to)! + 1)
  const queue = [...nodes.keys()].filter(k => !into.get(k))
  if (!queue.length) queue.push(m.nodes[0].id)
  const placed = new Set<string>()
  const forward = new Set<(typeof edges)[number]>()
  while (placed.size < nodes.size) {
    const id = queue.shift() ?? [...nodes.keys()].find(k => !placed.has(k))!
    if (placed.has(id)) continue
    placed.add(id)
    for (const e of edges) {
      if (e.from !== id || placed.has(e.to)) continue
      forward.add(e)
      const to = nodes.get(e.to)!
      to.layer = Math.max(to.layer, nodes.get(id)!.layer + 1)
      into.set(e.to, into.get(e.to)! - 1)
      if (!into.get(e.to)) queue.push(e.to)
    }
  }
  const layers: Node[][] = []
  for (const n of nodes.values()) (layers[n.layer] ??= []).push(n)
  // Order each layer by where the nodes leading to it sit, so arrows cross less.
  layers.forEach((layer, i) => {
    if (i)
      layer.sort((a, b) => {
        const at = (n: Node) => {
          const from = edges.filter(e => e.to === n.id).map(e => nodes.get(e.from)!).filter(p => p.layer < i)
          return from.length ? from.reduce((s, p) => s + p.order, 0) / from.length : n.order
        }
        return at(a) - at(b)
      })
    layer.forEach((n, k) => (n.order = k))
  })

  // Positions in the chart's own space: layers in rows (or columns), each centred.
  const GAP = 28, LAYER_GAP = 46
  const along = (n: Node) => (across ? n.h : n.w)
  const deep = (n: Node) => (across ? n.w : n.h)
  const spans = layers.map(l => l.reduce((s, n) => s + along(n), 0) + GAP * (l.length - 1))
  const widest = Math.max(...spans)
  let depth = 0
  layers.forEach((layer, i) => {
    const thick = Math.max(...layer.map(deep))
    let pos = (widest - spans[i]) / 2
    for (const n of layer) {
      const a = pos + along(n) / 2, d = depth + thick / 2
      ;[n.x, n.y] = across ? [d, a] : [a, d]
      pos += along(n) + GAP
    }
    depth += thick + LAYER_GAP
  })
  depth -= LAYER_GAP
  const [w, h] = across ? [depth, widest] : [widest, depth]
  const area = { x: r.x + 16, y: r.y + (m.title ? TITLE_H + 10 : 16), w: r.w - 32, h: r.h - (m.title ? TITLE_H + 26 : 32) }
  const scale = Math.min(1.25, area.w / w, area.h / h)
  const inner = el('g', { transform: `translate(${area.x + (area.w - w * scale) / 2} ${area.y + (area.h - h * scale) / 2}) scale(${scale})` })
  beats.push({ dur: 0.01, together: true, start: () => g.append(inner), frame: () => {} }) // over the paper, once it is there
  const rect = (n: Node): Rect => ({ x: n.x - n.w / 2, y: n.y - n.h / 2, w: n.w, h: n.h })

  // Layer by layer: its nodes, then the arrows into them.
  layers.forEach(layer => {
    for (const n of layer) {
      const b = rect(n)
      beats.push(fadeIn(inner, () => (n.shape === 'diamond'
        ? el('polygon', { points: `${n.x},${b.y} ${b.x + b.w},${n.y} ${n.x},${b.y + b.h} ${b.x},${n.y}`, fill: color, 'fill-opacity': 0.08 })
        : el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: n.shape === 'round' ? b.h / 2 : 8, fill: color, 'fill-opacity': 0.08 })), 1, 0.2))
      beats.push(pen(inner, n.shape === 'diamond' ? diamond(b) : boxPath(b, n.shape === 'round' ? b.h / 2 : 8), color, { size: 2.6, speed: 1600 }))
      n.lines.forEach((line, k) => beats.push(words(inner, line, n.x, n.y + (k - (n.lines.length - 1) / 2) * 17, { fill: INK, size: 13 })))
    }
    for (const e of edges) {
      const to = nodes.get(e.to)!
      if (!layer.includes(to)) continue
      const from = nodes.get(e.from)!
      const a = exit(rect(from), [to.x, to.y], 5), b = exit(rect(to), [from.x, from.y], 6)
      const { shaft, head } = arrow(a, b, forward.has(e) ? 0 : 0.45)
      beats.push(pen(inner, shaft, INK, { size: 2.2, speed: 1400 }), pen(inner, head, INK, { size: 2.2, speed: 500 }))
      if (e.text) {
        const mid = shaft[Math.floor(shaft.length / 2)]
        const tw = textWidth(e.text, `600 11px ${UI_FONT}`) + 12
        beats.push(
          pop(
            inner,
            () => {
              const t = el('g', {})
              el('rect', { x: -tw / 2, y: -9, width: tw, height: 18, rx: 9, fill: PAPER, stroke: INK, 'stroke-opacity': 0.25 }, t)
              el('text', { fill: INK, 'font-family': UI_FONT, 'font-size': 11, 'font-weight': 600, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, t).textContent = e.text!
              return t
            },
            mid,
          ),
        )
      }
    }
  })
  return beats
}
