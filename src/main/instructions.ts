// Reading building instructions (LEGO's, or any laid out like them) from the words in their PDF: which pages hold
// which numbered steps, where on its page each step is, how many parts it takes, and which pages are the build at
// all. LEGO's PDFs keep their numbers as text, set in sizes that say what they are: one size for step numbers, a
// smaller one for page numbers, a tiny one for the part counts in each step's parts box. So the steps are the numbers
// of one size that count up, page after page; pages of nothing but their page number around them are part of the
// build too (the minifigure, joining two halves, the finished model), and the rest (covers, adverts, the parts list)
// is left out.
import type { Box } from '../shared/marks'

export interface Word {
  t: string
  /** The height of its line, in page points: it stands in for the font size. */
  h: number
  /** Page points, top-left origin. */
  box: Box
}

export interface Page {
  size: [number, number]
  words: Word[]
}

/** One thing to look at while building: a step, or a page between steps. */
export interface View {
  /** The booklet (from 0) and the page in it (from 0). */
  book: number
  page: number
  /** The step's number, or for a page between steps, the number of the step before it (0 before the first). */
  step: number
  between?: boolean
  /** Where the step is on its page, in page points, when the page holds more than one. */
  crop?: Box
  /** The parts it takes, from the counts in its parts box. */
  parts?: number
  /** How many times it is built, when the page says (a big 2x beside a sub-build). */
  times?: number
}

const NUMBER = /^\d{1,4}$/
const COUNT = /^(\d{1,2})x$/i
const MIN_STEPS = 3 // fewer numbers counting up than this aren't steps
const FOOT = 0.88 // page numbers sit below this share of the page's height
const GAP = 12 // points between a step's area and the next one's number

/** "1122" for 12, where a PDF draws each digit twice (once for its outline): the number it means. */
const undoubled = (t: string) => (t.length % 2 === 0 && [...t].every((c, i) => i % 2 || c === t[i + 1]) ? t.replace(/(.)./g, '$1') : null)

interface Found {
  page: number
  n: number
  box: Box
}

/** The step numbers in one booklet: the longest run of numbers of one size counting up by one, in page order. */
function stepNumbers(pages: Page[]): Found[] {
  const bySize = new Map<number, { page: number; ns: number[]; box: Box }[]>()
  pages.forEach((p, page) => {
    for (const w of p.words) {
      if (!NUMBER.test(w.t) || w.box[1] > FOOT * p.size[1]) continue
      const size = Math.round(w.h * 2) / 2
      const ns = [Number(w.t), ...(undoubled(w.t) ? [Number(undoubled(w.t))] : [])]
      if (!bySize.has(size)) bySize.set(size, [])
      bySize.get(size)!.push({ page, ns, box: w.box })
    }
  })
  let best: Found[] = []
  for (const list of bySize.values()) {
    // Page by page; on a page, smallest first (a page of two steps side by side may set the second one higher).
    list.sort((a, b) => a.page - b.page || a.ns.at(-1)! - b.ns.at(-1)!)
    // Runs by the number each expects next; a number either carries one on or starts its own.
    const runs = new Map<number, Found[]>()
    for (const { page, ns, box } of list) {
      const n = ns.find(v => runs.has(v)) ?? ns[0]
      const run = [...(runs.get(n) ?? []), { page, n, box }]
      runs.delete(n)
      if ((runs.get(n + 1)?.length ?? 0) < run.length) runs.set(n + 1, run)
      if (run.length > best.length) best = run
    }
  }
  return best.length >= MIN_STEPS ? best : []
}

/** A page with nothing on it but its page number: a picture of the build between steps (or the finished model). */
function bare(p: Page): boolean {
  return p.words.length > 0 && p.words.every(w => NUMBER.test(w.t) && w.box[1] > FOOT * p.size[1])
}

const inside = (b: Box, [x, y]: [number, number]) => x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3]
const middle = (b: Box): [number, number] => [b[0] + b[2] / 2, b[1] + b[3] / 2]

/**
 * Splits a page between the steps on it. Two steps side by side divide it just left of the second one's number
 * (its parts box starts there too); one above another, just above the second one's parts box.
 */
function areas(page: Page, steps: Found[]): Box[] {
  const [W, H] = page.size
  const areas: Box[] = steps.map(() => [0, 0, W, H])
  const counts = page.words.filter(w => COUNT.test(w.t))
  for (let i = 0; i < steps.length; i++) {
    for (let j = i + 1; j < steps.length; j++) {
      const [a, b] = [steps[i].box, steps[j].box]
      if (!inside(areas[i], middle(b)) && !inside(areas[j], middle(a))) continue
      const [ai, bj] = [areas[i], areas[j]]
      if (Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1])) {
        const [left, right] = b[0] > a[0] ? [ai, bj] : [bj, ai]
        const x = Math.max(b[0], a[0]) - GAP
        right[2] -= x - right[0]
        right[0] = x
        left[2] = x - left[0]
      } else {
        const [upper, lower, number] = b[1] > a[1] ? [ai, bj, b] : [bj, ai, a]
        // The lower step's parts box sits over its number: start the step above the box's counts.
        const box = counts.filter(c => c.box[1] < number[1] && c.box[1] > number[1] - 90 && c.box[0] > number[0] - GAP)
        const top = Math.min(number[1], ...box.map(c => c.box[1] - 50)) - GAP
        const y = Math.max(top, upper[1] + 40)
        lower[3] -= y - lower[1]
        lower[1] = y
        upper[3] = y - upper[1]
      }
    }
  }
  return areas
}

/** The parts a step takes, and how many times it is built, from the counts in its area. */
function counts(page: Page, area: Box): { parts?: number; times?: number } {
  const all = page.words.filter(w => COUNT.test(w.t) && inside(area, middle(w.box)))
  if (!all.length) return {}
  const small = Math.min(...all.map(w => w.h))
  const n = (w: Word) => Number(COUNT.exec(w.t)![1])
  const parts = all.filter(w => w.h < small * 1.6).reduce((sum, w) => sum + n(w), 0)
  const big = all.filter(w => w.h >= small * 1.6)
  return { ...(parts ? { parts } : {}), ...(big.length ? { times: Math.max(...big.map(n)) } : {}) }
}

/**
 * The views to step through, booklet after booklet: each numbered step, each page between them, and the bare pages
 * just before the first step and after the last. A booklet with no steps found is shown page by page.
 */
export function read(books: Page[][]): { views: View[]; steps: number } {
  const views: View[] = []
  let steps = 0
  books.forEach((pages, book) => {
    const found = stepNumbers(pages)
    if (!found.length) {
      pages.forEach((_, page) => views.push({ book, page, step: 0, between: true }))
      return
    }
    let first = found[0].page
    let last = found.at(-1)!.page
    while (first > 0 && bare(pages[first - 1])) first--
    while (last < pages.length - 1 && bare(pages[last + 1])) last++
    let before = found[0].n - 1
    for (let page = first; page <= last; page++) {
      const here = found.filter(f => f.page === page)
      if (!here.length) {
        views.push({ book, page, step: before, between: true })
        continue
      }
      const split = here.length > 1 ? areas(pages[page], here) : null
      here.forEach((f, i) => {
        const area: Box = split?.[i] ?? [0, 0, ...pages[page].size]
        views.push({ book, page, step: f.n, ...(split ? { crop: area.map(v => Math.round(v * 10) / 10) as Box } : {}), ...counts(pages[page], area) })
        before = f.n
      })
    }
    steps += found.length
  })
  return { views, steps }
}
