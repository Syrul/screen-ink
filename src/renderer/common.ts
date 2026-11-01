// What the overlay's pieces share: beats, easing, SVG elements and text measuring.

/** One animated piece of a mark. A drawing's beats play one after another. */
export interface Beat {
  dur: number
  /** Start together with the beat before instead of after it. */
  together?: boolean
  start?: () => void
  frame: (t: number) => void
}

export const NS = 'http://www.w3.org/2000/svg'
export const UI_FONT = '-apple-system, "SF Pro Text", system-ui, sans-serif'

export const now = () => performance.now() / 1000
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const easePen = (t: number) => 0.5 - Math.cos(Math.PI * t) / 2
export const easeBack = (t: number) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2

export function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  parent?.append(e)
  return e
}

const measure = document.createElement('canvas').getContext('2d')!
export function textWidth(text: string, font: string): number {
  measure.font = font
  return measure.measureText(text).width
}
