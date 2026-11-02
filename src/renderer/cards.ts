// Cards with words in them, standing beside what they explain: notes, code, formulas, photos and buttons. They are
// HTML in the cards layer, so text wraps and formulas typeset; code, photos and buttons take clicks (the overlay
// takes the mouse over anything `.interactive`).
import temml from 'temml'
import type { Box, Mark, Point } from '../shared/marks'
import { clamp, easeBack, type Beat } from './common'
import { beside } from './ink'
import type { Rect } from './shapes'
import { tap } from './sounds'

type Of<K extends Mark['kind']> = Extract<Mark, { kind: K }>
type Near = { box?: number[]; at?: number[]; side?: 'above' | 'below' | 'left' | 'right' }
export type Act = 'copy' | 'open' | 'type'
/** What came of a click: done as asked, copied instead (text with line breaks isn't typed), or not at all. */
export type Outcome = 'done' | 'copied' | null

export interface Place {
  P: (p: Point) => Point
  R: (b: Box) => Rect
}

export interface CardHooks {
  /** Does what a button says, once the user has clicked it. */
  act(what: Act, value: string): Promise<Outcome>
}

/** Where a w×h card goes: beside its box, at its point, or top right. */
function spot(n: Near, w: number, h: number, { P, R }: Place): Point {
  if (n.box) {
    const [cx, cy] = beside(R(n.box as Box), n.side ?? 'right', w, h)
    return [cx - w / 2, cy - h / 2]
  }
  if (n.at) {
    const [x, y] = P(n.at as Point)
    return [clamp(x, 6, innerWidth - w - 6), clamp(y, 6, innerHeight - h - 6)]
  }
  return [innerWidth - w - 40, 80]
}

/** Pops an HTML card in where `where` puts it once its size is known. */
function popCard(host: HTMLElement, build: () => HTMLElement, where: (w: number, h: number) => Point): Beat {
  let node: HTMLElement
  return {
    dur: 0.35,
    start: () => {
      node = build()
      node.style.opacity = '0'
      host.append(node)
      const [x, y] = where(node.offsetWidth, node.offsetHeight)
      Object.assign(node.style, { left: `${x}px`, top: `${y}px` })
      tap()
    },
    frame: t => {
      node.style.opacity = String(clamp(t * 3, 0, 1))
      node.style.transform = `scale(${0.92 + 0.08 * easeBack(t)})`
    },
  }
}

function div(className: string, parent?: HTMLElement, text?: string): HTMLDivElement {
  const d = document.createElement('div')
  d.className = className
  if (text !== undefined) d.textContent = text
  parent?.append(d)
  return d
}

function title(card: HTMLElement, text: string, color: string): void {
  div('ink-card-title', card, text).style.background = color
}

/** A button that does `what` with `value` when clicked, and says so for a moment. */
function button(text: string, what: Act, value: string, hooks: CardHooks, className: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = className
  b.textContent = text
  b.title = what === 'type' ? `Types: ${value}` : what === 'open' ? `Opens ${value}` : `Copies: ${value}`
  const done = { copy: 'Copied', open: 'Opened', type: 'Typed' }[what]
  b.addEventListener('click', async () => {
    b.disabled = true
    const outcome = await hooks.act(what, value).catch(() => null)
    b.textContent = outcome === 'done' ? `${done} ✓` : outcome === 'copied' ? 'Copied ✓' : "Couldn't"
    setTimeout(() => {
      b.textContent = text
      b.disabled = false
    }, 1600)
  })
  return b
}

export function noteBeats(m: Of<'note'>, color: string, host: HTMLElement, at: Place): Beat[] {
  return [
    popCard(
      host,
      () => {
        const card = div('ink-card note')
        if (m.title) title(card, m.title, color)
        div('note-text', card, m.text)
        return card
      },
      (w, h) => spot(m, w, h, at),
    ),
  ]
}

// Just enough colouring to read code by: comments, strings, numbers and common keywords.
const TOKENS =
  /(\/\/.*$|#(?![0-9a-fA-F]{3,8}\b).*$|--\s.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|\b(\d+(?:\.\d+)?)\b|\b(const|let|var|function|return|if|else|elif|for|while|in|of|import|from|export|class|def|async|await|try|catch|except|new|true|false|null|undefined|None|True|False|sudo|cd|npm|npx|git|brew|pip|echo|export)\b/gm

function colour(line: string, into: HTMLElement): void {
  let last = 0
  for (const t of line.matchAll(TOKENS)) {
    if (t.index! > last) into.append(line.slice(last, t.index))
    const span = document.createElement('span')
    span.className = t[1] ? 'c' : t[2] ? 's' : t[3] ? 'n' : 'k'
    span.textContent = t[0]
    into.append(span)
    last = t.index! + t[0].length
  }
  into.append(line.slice(last))
}

export function codeBeats(m: Of<'code'>, color: string, host: HTMLElement, at: Place, hooks: CardHooks): Beat[] {
  return [
    popCard(
      host,
      () => {
        const card = div('ink-card code interactive')
        const head = div('code-head', card)
        div('code-title', head, m.title ?? 'Code')
        head.append(button('Copy', 'copy', m.code, hooks, 'code-copy'))
        const body = div('code-body', card)
        const marked = new Set(m.highlight ?? [])
        m.code.replace(/\n$/, '').split('\n').forEach((line, i) => {
          const row = div(marked.has(i + 1) ? 'code-line marked' : 'code-line', body)
          if (marked.has(i + 1)) row.style.setProperty('--mark', color)
          div('code-no', row, String(i + 1))
          colour(line || ' ', div('code-src', row))
        })
        return card
      },
      (w, h) => spot(m, w, h, at),
    ),
  ]
}

export function mathBeats(m: Of<'math'>, color: string, host: HTMLElement, at: Place): Beat[] {
  return [
    popCard(
      host,
      () => {
        const card = div('ink-card math')
        card.style.color = color
        // temml writes MathML, which Chromium typesets; commands that could link or style (\href, \class) stay off.
        card.innerHTML = temml.renderToString(m.tex, { displayMode: true, throwOnError: false, trust: false })
        return card
      },
      (w, h) => spot(m, w, h, at),
    ),
  ]
}

export function photoBeats(m: Of<'photo'>, color: string, host: HTMLElement, at: Place, hooks: CardHooks): Beat[] {
  const r = at.R(m.box as Box)
  if (!m.url.startsWith('data:image/')) return [] // the main process fetches it; it couldn't
  return [
    popCard(
      host,
      () => {
        const card = div('ink-card photo interactive')
        card.style.maxWidth = `${Math.max(160, r.w)}px`
        const img = document.createElement('img')
        img.src = m.url
        img.alt = m.caption ?? ''
        img.style.maxHeight = `${Math.max(100, r.h - (m.caption ? 64 : 40))}px`
        card.append(img)
        if (m.caption) div('photo-caption', card, m.caption)
        const link = /^https:\/\//.test(m.source)
        const source = link ? button(sourceName(m.source), 'open', m.source, hooks, 'photo-source') : div('photo-source', undefined, m.source)
        source.style.color = color
        card.append(source)
        return card
      },
      (w, h) => [clamp(r.x + (r.w - w) / 2, 6, innerWidth - w - 6), clamp(r.y + (r.h - h) / 2, 6, innerHeight - h - 6)],
    ),
  ]
}

function sourceName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function actionBeats(m: Of<'action'>, color: string, host: HTMLElement, at: Place, hooks: CardHooks): Beat[] {
  return [
    popCard(
      host,
      () => {
        const b = button(m.text, m.do, m.value, hooks, 'ink-action interactive')
        b.style.background = color
        return b
      },
      (w, h) => spot(m, w, h, at),
    ),
  ]
}
