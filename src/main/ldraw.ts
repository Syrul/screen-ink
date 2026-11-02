// LDraw models (ldraw.org's open format for LEGO models), to show a step of the instructions in 3D. A model is one
// file, or an MPD of several: the main model and the sub-models it places (a minifigure, a sub-build), each a list of
// steps that place parts or sub-models. The steps are laid out in the order a booklet builds them, two ways (sub-builds
// as part of the step that places them, or as steps of their own before it), and lined up with the booklet's steps
// by how many parts each takes: models made from the booklets follow them closely but not exactly (a step split in
// two, two merged, a stand added at the end), so the way that lines up best is kept, if it lines up well enough.
// Each step is then drawn as a small model of its own: the parts placed so far, and after a STEP line the new ones.

/** A part or sub-model placed: its colour, where (x y z, then the 3×3 matrix a..i), and its file. */
export interface Ref {
  color: number
  m: number[]
  name: string
}

export interface Model {
  /** The main model's file (lower case). */
  main: string
  /** Each model file in it (the main model and its sub-models), by lower-case name, as its steps. */
  files: Map<string, Ref[][]>
  /** The parts it brings along (.dat files, not in LDraw's library), by lower-case name, as their text. */
  own: Map<string, string>
  author?: string
}

/** One step of the model: the `step`th of `file`. */
export interface Entry {
  file: string
  step: number
}

/** A view of the instructions in 3D: `file` built through `step`, the parts of the steps after `from` new. */
export interface Shown {
  file: string
  step: number
  from: number
}

const MAIN_COLOR = 16
const DEPTH = 16 // sub-models this deep are a loop
const MERGE = 1 // what lining a booklet step up with two of the model's (or two with one) costs, beyond the parts
const SKIP = 2 // and leaving a step out on either side
const GOOD = 0.6 // the most cost per booklet step that still lines up

const key = (name: string) => name.trim().replace(/\\/g, '/').toLowerCase()

/** Reads a model: an MPD's files, or one file as its own main model. */
export function parse(text: string): Model {
  const files = new Map<string, Ref[][]>()
  const own = new Map<string, string>()
  let main = ''
  let author: string | undefined
  let steps = null as Ref[][] | null // the model file being read
  let step: Ref[] = []
  let part = null as string[] | null // or the part, as its lines
  const end = () => {
    if (steps && step.length) steps.push(step)
    step = []
  }
  const open = (name: string) => {
    end()
    steps = part = null
    if (/\.dat$/i.test(name)) part = []
    else {
      files.set(key(name), (steps = []))
      main ||= key(name)
    }
    return key(name)
  }
  let file = ''
  const close = () => {
    if (part) own.set(file, part.join('\n'))
    end()
    steps = part = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim().split(/\s+/)
    if (t[0] === '0' && (t[1] === 'FILE' || t[1] === 'NOFILE')) {
      close()
      if (t[1] === 'FILE') file = open(raw.trim().slice(7).trim())
    } else if (part) part.push(raw)
    else if (t[0] === '0') {
      if (t[1] === 'STEP' || t[1] === 'ROTSTEP') end()
      else if (/^Author:/i.test(t[1] ?? '') && !author) author = raw.trim().slice(2).replace(/^Author:\s*/i, '').trim() || undefined
    } else if (t[0] === '1' && t.length >= 15) {
      if (!steps) file = open('main.ldr')
      const m = t.slice(2, 14).map(Number)
      if (m.every(Number.isFinite)) step.push({ color: Number(t[1]), m, name: key(t.slice(14).join(' ')) })
    }
  }
  close()
  return { main, files, own, author }
}

/** `child` placed by `parent`: where it ends up, as x y z a..i. */
function compose(p: number[], c: number[]): number[] {
  const [px, py, pz, a, b, cc, d, e, f, g, h, i] = p
  const [cx, cy, cz, ...r] = c
  const M = [a, b, cc, d, e, f, g, h, i]
  const mul = (row: number, col: number) => M[row * 3] * r[col] + M[row * 3 + 1] * r[3 + col] + M[row * 3 + 2] * r[6 + col]
  return [
    a * cx + b * cy + cc * cz + px,
    d * cx + e * cy + f * cz + py,
    g * cx + h * cy + i * cz + pz,
    mul(0, 0), mul(0, 1), mul(0, 2), mul(1, 0), mul(1, 1), mul(1, 2), mul(2, 0), mul(2, 1), mul(2, 2),
  ]
}

const IDENTITY = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]

/** The parts `refs` place, sub-models opened up, where they end up under `at` and with what colour. */
function leaves(model: Model, refs: Ref[], at = IDENTITY, color = MAIN_COLOR, depth = 0, out: Ref[] = []): Ref[] {
  for (const r of refs) {
    const c = r.color === MAIN_COLOR ? color : r.color
    const m = compose(at, r.m)
    const sub = model.files.get(r.name)
    if (!sub) out.push({ color: c, m, name: r.name })
    else if (depth < DEPTH) leaves(model, sub.flat(), m, c, depth + 1, out)
  }
  return out
}

/** How many parts each entry places, counting a sub-model's parts only where it isn't built in steps of its own. */
function counts(model: Model, entries: Entry[]): number[] {
  const own = new Set(entries.map(e => e.file))
  return entries.map(e =>
    (model.files.get(e.file)![e.step] ?? []).reduce((n, r) => n + (!model.files.has(r.name) ? 1 : own.has(r.name) ? 0 : leaves(model, [r]).length), 0),
  )
}

/** The model's steps in the order a booklet builds them: the main model's, with sub-builds inside the steps that place them. */
function mainSteps(model: Model): Entry[] {
  return model.files.get(model.main)!.map((_, step) => ({ file: model.main, step }))
}

/** Or each sub-model's steps first, before the step that places it. */
function allSteps(model: Model): Entry[] {
  const out: Entry[] = []
  const seen = new Set<string>()
  const walk = (file: string, depth: number) => {
    seen.add(file)
    model.files.get(file)!.forEach((refs, step) => {
      for (const r of refs) if (model.files.has(r.name) && !seen.has(r.name) && depth < DEPTH) walk(r.name, depth + 1)
      out.push({ file, step })
    })
  }
  walk(model.main, 0)
  return out
}

/**
 * Lines the booklet's steps (their part counts, unknown where the page didn't say) up with the model's: for each
 * booklet step, the last model step it takes in, or -1. Also what it cost, per booklet step.
 */
export function align(booklet: (number | undefined)[], model: number[]): { map: number[]; cost: number } {
  const n = booklet.length
  const m = model.length
  const diff = (a: number | undefined, b: number) => (a === undefined ? 0.5 : Math.min(Math.abs(a - b), 4))
  const D = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Infinity))
  const from = Array.from({ length: n + 1 }, () => new Array<[number, number]>(m + 1))
  D[0][0] = 0
  const relax = (i: number, j: number, i2: number, j2: number, c: number) => {
    if (i2 <= n && j2 <= m && D[i][j] + c < D[i2][j2]) {
      D[i2][j2] = D[i][j] + c
      from[i2][j2] = [i, j]
    }
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (D[i][j] === Infinity) continue
      if (i < n && j < m) relax(i, j, i + 1, j + 1, diff(booklet[i], model[j]))
      if (i + 1 < n && j < m) relax(i, j, i + 2, j + 1, MERGE + diff(booklet[i] === undefined || booklet[i + 1] === undefined ? undefined : booklet[i]! + booklet[i + 1]!, model[j]))
      if (i < n && j + 1 < m) relax(i, j, i + 1, j + 2, MERGE + diff(booklet[i], model[j] + model[j + 1]))
      if (i < n) relax(i, j, i + 1, j, SKIP)
      if (j < m) relax(i, j, i, j + 1, SKIP)
    }
  }
  // Back from the end: each booklet step gets the last model step of its pair.
  const map = new Array<number>(n).fill(-1)
  let [i, j] = [n, m]
  while (i > 0 || j > 0) {
    const [pi, pj] = from[i][j]
    for (let k = pi; k < i; k++) map[k] = j - 1
    ;[i, j] = [pi, pj]
  }
  // A step left out shows what the one before it did.
  for (let k = 1; k < n; k++) if (map[k] < map[k - 1]) map[k] = map[k - 1]
  return { map, cost: n ? D[n][m] / n : Infinity }
}

/**
 * What each view of the booklet shows in 3D, given its steps' numbers and part counts: null where nothing does
 * (before the first step), and nothing at all when the model doesn't line up with the booklet.
 */
export function plan(model: Model, views: { step: number; between?: boolean; parts?: number }[]): (Shown | null)[] | null {
  const steps = views.filter(v => !v.between)
  if (!steps.length || !model.files.get(model.main)?.length) return null
  let best: { entries: Entry[]; map: number[]; cost: number } | null = null
  for (const entries of [mainSteps(model), allSteps(model)]) {
    const { map, cost } = align(
      steps.map(v => v.parts),
      counts(model, entries),
    )
    if (!best || cost < best.cost) best = { entries, map, cost }
  }
  if (!best || best.cost > GOOD) return null
  // Each step shows its file built through its model step; new are the steps since that file was last shown.
  const shown = new Map<string, number>()
  const out: (Shown | null)[] = []
  let k = 0
  let last: Shown | null = null
  const end = model.files.get(model.main)!.length - 1
  views.forEach((v, i) => {
    if (v.between) {
      const after = views.slice(i + 1).every(w => w.between)
      out.push(after ? { file: model.main, step: end, from: end } : last && { ...last, from: last.step })
      return
    }
    const e = best!.map[k++]
    if (e < 0) return void out.push(null)
    const { file, step } = best!.entries[e]
    const s: Shown = { file, step, from: Math.min(shown.get(file) ?? -1, step - 1) }
    shown.set(file, step)
    out.push((last = s))
  })
  return out
}

/** The parts of a view, as the lines of an LDraw model: those placed before, a STEP, then the new ones. */
export function stepModel(model: Model, s: Shown): { old: string[]; added: string[] } {
  const steps = model.files.get(s.file) ?? []
  const line = (r: Ref) => `1 ${r.color} ${r.m.map(v => +v.toFixed(4)).join(' ')} ${r.name}`
  return {
    old: leaves(model, steps.slice(0, s.from + 1).flat()).map(line),
    added: leaves(model, steps.slice(s.from + 1, s.step + 1).flat()).map(line),
  }
}

/** The parts the whole model uses (lower case, as its lines name them). */
export function parts(model: Model): Set<string> {
  return new Set(leaves(model, model.files.get(model.main)!.flat()).map(r => r.name))
}
