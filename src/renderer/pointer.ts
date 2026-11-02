// screen-ink's own pointer: a second cursor in the ink's colour. It leaves the user's mouse as a drawing starts and
// moves to each mark as the pen draws it, so the drawing reads as someone pointing, and when screen-ink does a
// walkthrough's steps for the user it moves to each one and presses it where they can see. It is only drawn: the
// real mouse stays the user's.
import type { Box, Mark, Point } from '../shared/marks'
import { clamp } from './common'
import type { Rect } from './shapes'

const REMEMBER_S = 4 // a drawing this soon after the pointer was last seen starts it from there
const TIP = 3 // where the arrow's tip is in its drawing, in px

const node = document.createElement('div')
node.id = 'pointer'
node.innerHTML =
  '<div class="pointer-body"><svg width="26" height="30" viewBox="0 0 26 30">' +
  '<path d="M3 3 L3 23.5 L8.4 18.6 L12.2 27 L16.1 25.3 L12.4 17.1 L19.6 17.1 Z" /></svg></div>' +
  '<span class="pointer-tag"></span>'
document.body.append(node)
const body = node.querySelector('.pointer-body') as HTMLDivElement
const tag = node.querySelector('.pointer-tag') as HTMLSpanElement

let on = true
let at: Point | null = null
let seen = 0 // when it was last showing, in ms
let moving: Animation | null = null

const place = ([x, y]: Point, turn = 0) => `translate(${x - TIP}px, ${y - TIP}px) rotate(${turn}deg)`

function show(): void {
  node.classList.add('show')
  seen = performance.now()
}

/**
 * A drawing starts. A new one (`fresh`) brings the pointer from where it was a moment ago, or from the user's
 * mouse; one added to the last keeps it where it is.
 */
export function enter(color: string, enabled: boolean, fresh: boolean, mouse?: Point): void {
  on = enabled
  node.style.setProperty('--pointer', color)
  if (!on) return hide(true)
  if (fresh && performance.now() - seen > REMEMBER_S * 1000) at = mouse ?? null
  if (at && !node.classList.contains('show')) node.style.transform = place(at)
}

/** Moves to `to`, in a gentle arc, and resolves once it is there. */
export function glide(to: Point, slow = 1): Promise<void> {
  if (!on) return Promise.resolve()
  const target: Point = [clamp(to[0], 4, innerWidth - 4), clamp(to[1], 4, innerHeight - 4)]
  moving?.cancel()
  const from = at
  at = target
  if (!from || !node.classList.contains('show')) {
    // Nowhere to come from: it appears there.
    node.style.transform = place(target)
    show()
    return Promise.resolve()
  }
  show()
  const [dx, dy] = [target[0] - from[0], target[1] - from[1]]
  const distance = Math.hypot(dx, dy)
  if (distance < 2) return Promise.resolve()
  // The arc bows to one side by a tenth of the way, and the pointer leans into the turn.
  const bow = 0.1 * distance
  const mid: Point = [(from[0] + target[0]) / 2 - (dy / distance) * bow, (from[1] + target[1]) / 2 + (dx / distance) * bow]
  const lean = clamp(dx / 40, -10, 10)
  const duration = clamp(220 + distance * 0.45, 260, 820) * slow
  node.style.transform = place(target)
  moving = node.animate(
    [{ transform: place(from) }, { transform: place(mid, lean), offset: 0.5 }, { transform: place(target) }],
    { duration, easing: 'cubic-bezier(.45, 0, .2, 1)' },
  )
  return moving.finished.then(
    () => {
      seen = performance.now()
    },
    () => {},
  )
}

/** Moves to `to` and presses there: the pointer dips and a ring spreads from its tip, with `label` beside it. */
export async function press(to: Point, label?: string): Promise<void> {
  if (!on) return
  tag.textContent = label ? `Pressing “${label}”` : 'Pressing'
  node.classList.add('pressing')
  await glide(to, 1.15)
  await new Promise(r => setTimeout(r, 160))
  const ripple = document.createElement('div')
  ripple.className = 'pointer-ripple'
  ripple.style.left = `${to[0]}px`
  ripple.style.top = `${to[1]}px`
  ripple.style.borderColor = getComputedStyle(node).getPropertyValue('--pointer')
  document.body.append(ripple)
  ripple.animate([{ transform: 'translate(-50%, -50%) scale(.2)', opacity: 0.9 }, { transform: 'translate(-50%, -50%) scale(2.6)', opacity: 0 }], {
    duration: 480,
    easing: 'cubic-bezier(.2, .7, .3, 1)',
  }).finished.then(() => ripple.remove(), () => ripple.remove())
  await body.animate([{ transform: 'scale(1)' }, { transform: 'scale(.78)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' }).finished
  setTimeout(() => node.classList.remove('pressing'), 900)
  seen = performance.now()
}

export function hide(instant = false): void {
  if (!node.classList.contains('show')) return
  if (instant) moving?.cancel()
  node.classList.remove('show', 'pressing')
  seen = performance.now()
}

/**
 * Where the pointer goes for a mark, in page px: over a target the way a hand hovers (a little below and right of
 * its middle), at the end of a stroke, or at the corner of a card rather than on it. Null for marks that place
 * themselves (a card in the corner).
 */
export function aim(m: Mark, P: (p: Point) => Point, R: (b: Box) => Rect): Point | null {
  const hover = (r: Rect): Point => [r.x + r.w * 0.62, r.y + r.h * 0.66]
  const corner = (r: Rect): Point => [r.x + r.w + 4, r.y + r.h + 4]
  const near = (p: Point): Point => [p[0] + 8, p[1] + 8]
  switch (m.kind) {
    case 'arrow':
      return near(P(m.to as Point))
    case 'line':
      return near(P(m.points[m.points.length - 1] as Point))
    case 'badge':
    case 'check':
    case 'cross':
    case 'text':
      return near(P(m.at as Point))
    case 'connect':
      return hover(R(m.to as Box))
    case 'ring':
    case 'frame':
    case 'underline':
    case 'highlight':
    case 'strike':
    case 'spotlight':
      return hover(R(m.box as Box))
    case 'label':
    case 'note':
    case 'code':
    case 'math':
    case 'steps':
    case 'action':
      return m.box ? hover(R(m.box as Box)) : m.at ? near(P(m.at as Point)) : null
    case 'plot':
    case 'timeline':
    case 'flow':
    case 'photo':
    case 'figure':
      return corner(R(m.box as Box))
    default:
      return null
  }
}
