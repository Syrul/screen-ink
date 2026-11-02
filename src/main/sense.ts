// What is on screen, as elements a mark can name instead of guessing coordinates: the frontmost app's controls from
// the Accessibility API, and every line of text Vision reads, mapped into the screenshot's units and numbered. A
// Swift helper (native/sense.swift, built to dist/screen-ink-sense) does the looking. Without it, marks fall back to
// coordinates; without Accessibility access, the list has the text but not the controls.
import { systemPreferences, type Display } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Box, Mark, MarkInput, Point } from '../shared/marks'

export interface Element {
  id: string
  kind: string
  text: string
  box: Box
}

interface Reply {
  id: number
  trusted: boolean
  ax: { role: string; subrole: string; label: string; frame: Box }[]
  ocr: { text: string; box: Box; confidence: number }[]
}

// Packaged, it is unpacked beside the app's archive, since a program inside one can't be run.
const HELPER = path.join(__dirname, 'screen-ink-sense').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
const WAIT_MS = 3000 // the most a question waits for the list; it is usually ready long before
const MAX_ELEMENTS = 300

let helper: ChildProcess | null = null
let lastId = 0
const waiting = new Map<number, (reply: Reply | null) => void>()
const clickers = new Set<(at: Point) => void>()
let asked = false

/** Starts the helper, early: it learns which app is in front by watching the user switch apps. */
export function start(): void {
  if (helper || process.platform !== 'darwin' || !fs.existsSync(HELPER)) return
  const child = (helper = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'inherit'] }))
  readline.createInterface({ input: child.stdout! }).on('line', line => {
    let reply: Reply
    try {
      reply = JSON.parse(line)
    } catch {
      return
    }
    const click = (reply as { click?: Point }).click
    if (click) for (const fn of clickers) fn(click)
    waiting.get(reply.id)?.(reply)
    waiting.delete(reply.id)
  })
  const gone = () => {
    if (helper === child) helper = null
    for (const done of waiting.values()) done(null)
    waiting.clear()
  }
  child.on('error', gone)
  child.on('exit', gone)
  child.stdin!.on('error', () => {})
}

/** Sends the helper one request and waits for its reply, or null if there is no helper or it takes too long. */
function request(body: Record<string, unknown>, waitMs = WAIT_MS): Promise<Reply | null> {
  start()
  const child = helper
  if (!child) return Promise.resolve(null)
  const id = ++lastId
  return new Promise<Reply | null>(resolve => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      resolve(null)
    }, waitMs)
    waiting.set(id, r => {
      clearTimeout(timer)
      resolve(r)
    })
    child.stdin!.write(JSON.stringify({ id, ...body }) + '\n')
  })
}

function askForAccess(reply: Reply | null): void {
  if (!reply || reply.trusted || asked) return
  asked = true
  console.log('screen-ink: allow Accessibility (System Settings → Privacy & Security) so marks land exactly on buttons and menus.')
  systemPreferences.isTrustedAccessibilityClient(true)
}

/** Lists what is on `display`, given its screenshot (`jpeg`, any size) and the units marks use (`width`, `height`, `ppu`). */
export async function sense(display: Display, jpeg: Buffer, width: number, height: number, ppu: number): Promise<Element[]> {
  const { x, y, width: w, height: h } = display.bounds
  const reply = await request({ jpeg: jpeg.toString('base64'), display: [x, y, w, h] })
  askForAccess(reply)
  return reply ? merge(reply, display.bounds, width, height, ppu) : []
}

/** Types `text` into the app in front, as if from the keyboard. Resolves whether it could (it needs Accessibility). */
export async function type(text: string): Promise<boolean> {
  const reply = await request({ type: text }, 10_000)
  askForAccess(reply)
  return !!reply?.trusted
}

/** What the app in front has at a point, as the helper would press it: pressed, typed into, or clicked. */
export interface Target {
  role: string
  subrole: string
  label: string
  how: 'press' | 'focus' | 'click'
}

/**
 * Presses what the app in front has at `at` (global points, top-left origin), or with `dry` only says what it would
 * press. Resolves the target, or why it won't. Needs Accessibility.
 */
export async function press(at: Point, dry = false): Promise<{ target?: Target; refused?: string }> {
  const reply = (await request({ press: at, dry }, 5000)) as (Reply & { target?: Target; refused?: string }) | null
  if (!reply) return { refused: "the helper didn't answer" }
  if (!reply.trusted) return { refused: 'screen-ink needs Accessibility to press things' }
  return { target: reply.target, refused: reply.refused }
}

/**
 * Calls `fn` with every left click anywhere (global points, top-left origin) until the returned function is called.
 * Resolves null when clicks can't be watched (no helper, or no Accessibility access).
 */
export async function watchClicks(fn: (at: Point) => void): Promise<(() => void) | null> {
  const reply = (await request({ watch: true })) as (Reply & { watching?: boolean }) | null
  askForAccess(reply)
  if (!reply?.watching) return null
  clickers.add(fn)
  return () => {
    clickers.delete(fn)
    if (!clickers.size) void request({ watch: false })
  }
}

const KINDS: Record<string, string> = {
  AXButton: 'button', AXMenuBarItem: 'menu', AXMenuItem: 'menu item', AXMenuButton: 'menu button', AXPopUpButton: 'pop-up menu',
  AXComboBox: 'combo box', AXTextField: 'field', AXTextArea: 'text area', AXSearchField: 'search field', AXCheckBox: 'checkbox',
  AXRadioButton: 'radio button', AXLink: 'link', AXSlider: 'slider', AXDisclosureTriangle: 'disclosure triangle',
  AXIncrementor: 'stepper', AXColorWell: 'colour well', AXStaticText: 'text', AXImage: 'image', AXHeading: 'heading',
  AXCell: 'cell', AXRow: 'row', AXTab: 'tab',
  // subroles say more than their roles
  AXSearchFieldSubrole: 'search field', AXSecureTextField: 'password field', AXSwitch: 'switch', AXToggle: 'toggle',
  AXTabButton: 'tab', AXCloseButton: 'close button', AXMinimizeButton: 'minimize button', AXFullScreenButton: 'full screen button',
  AXZoomButton: 'zoom button',
}
// What to keep first when there are too many: things you click or type in, then words, then the rest.
const RANK: Record<string, number> = { text: 1, heading: 1, cell: 2, row: 2, image: 3 }

const area = (b: Box) => b[2] * b[3]
function overlap(a: Box, b: Box): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])
  return w > 0 && h > 0 ? w * h : 0
}
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const says = (label: string, line: string) => {
  const a = words(label)
  const b = words(line)
  return !!a && !!b && (a.includes(b) || b.includes(a))
}

function merge(reply: Reply, bounds: Display['bounds'], width: number, height: number, ppu: number): Element[] {
  const fit = (b: Box): Box | null => {
    const x0 = Math.max(0, b[0])
    const y0 = Math.max(0, b[1])
    const x1 = Math.min(width, b[0] + b[2])
    const y1 = Math.min(height, b[1] + b[3])
    return x1 - x0 >= 2 && y1 - y0 >= 2 ? [x0, y0, x1 - x0, y1 - y0] : null
  }
  type Found = Omit<Element, 'id'>
  const controls: Found[] = []
  for (const a of reply.ax) {
    const box = fit([(a.frame[0] - bounds.x) / ppu, (a.frame[1] - bounds.y) / ppu, a.frame[2] / ppu, a.frame[3] / ppu])
    const kind = KINDS[a.subrole === 'AXSearchField' ? 'AXSearchFieldSubrole' : a.subrole] ?? KINDS[a.role]
    if (!box || !kind) continue
    // A row, its cell and its text often share one box: keep the first, which the walk met as the outermost.
    const twin = controls.find(c => overlap(c.box, box) > 0.85 * Math.max(area(c.box), area(box)))
    if (twin && (!a.label || says(twin.text, a.label))) {
      if ((RANK[twin.kind] ?? 0) > (RANK[kind] ?? 0)) twin.kind = kind
      twin.text ||= a.label
      continue
    }
    controls.push({ kind, text: a.label, box })
  }
  const lines: Found[] = []
  for (const o of reply.ocr) {
    const box = fit([o.box[0] * width, o.box[1] * height, o.box[2] * width, o.box[3] * height])
    const text = o.text.trim().slice(0, 80)
    if (!box || !text || o.confidence < 0.3) continue
    // A line of text inside a control is usually its label: it names a control that has none, and is dropped
    // where the control already says it.
    const host = controls
      .filter(c => overlap(c.box, box) >= 0.6 * area(box))
      .sort((a, b) => area(a.box) - area(b.box))[0]
    if (host && !host.text && overlap(host.box, box) >= 0.7 * area(box)) host.text = text
    else if (!host || !says(host.text, text)) lines.push({ kind: 'text', text, box })
  }
  const all = [...controls, ...lines]
    .map((e, i) => ({ e, i, rank: (RANK[e.kind] ?? 0) + (e.text ? 0 : 1.5) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, MAX_ELEMENTS)
    .map(({ e }) => e)
  // Reading order: rows top to bottom (a row is anything within half a line of the same top), left to right.
  all.sort((a, b) => (Math.abs(a.box[1] - b.box[1]) < 6 ? a.box[0] - b.box[0] : a.box[1] - b.box[1]))
  return all.map((e, i) => ({ id: `e${i + 1}`, ...e, box: e.box.map(v => Math.round(v * 10) / 10) as Box }))
}

/** The list as the model reads it, after the screenshot. Empty when there is none. */
export function describe(elements: Element[]): string {
  if (!elements.length) return ''
  return [
    `Elements on screen: id, what it is, its text, its box [x, y, width, height]. To mark one, give its id in place of a box or point; an id lands exactly on it, while coordinates are guesses.`,
    ...elements.map(e => `${e.id} ${e.kind}${e.text ? ` ${JSON.stringify(e.text)}` : ''} [${e.box.map(Math.round).join(', ')}]`),
  ].join('\n')
}

const GAP_PT = 6 // between an arrow's tip and the element it points at
const BADGE_PT = 18 // a badge's radius plus a little air: it sits just left of its element

/** Replaces element ids in `marks` with their boxes and points. Marks naming an id the list doesn't have are dropped. */
export function place(marks: MarkInput[], elements: Element[], ppu: number): { marks: Mark[]; missing: string[] } {
  const byId = new Map(elements.map(e => [e.id, e.box]))
  const missing: string[] = []
  const look = (id: string): Box | null => byId.get(id) ?? (missing.push(id), null)
  const centre = (b: Box): Point => [b[0] + b[2] / 2, b[1] + b[3] / 2]
  // Where the line from `from` to the box's centre crosses its edge, backed off by the gap.
  const edge = (b: Box, from: Point): Point => {
    const [cx, cy] = centre(b)
    const dx = from[0] - cx
    const dy = from[1] - cy
    const t = Math.min(dx ? b[2] / 2 / Math.abs(dx) : Infinity, dy ? b[3] / 2 / Math.abs(dy) : Infinity, 1)
    const len = Math.hypot(dx, dy) || 1
    const gap = GAP_PT / ppu / len
    return [cx + dx * Math.min(1, t + gap), cy + dy * Math.min(1, t + gap)]
  }
  const placed = marks.flatMap((m): Mark[] => {
    if ('box' in m && typeof m.box === 'string') {
      const box = look(m.box)
      return box ? [{ ...m, box } as Mark] : []
    }
    if (m.kind === 'connect') {
      const from = typeof m.from === 'string' ? look(m.from) : m.from
      const to = typeof m.to === 'string' ? look(m.to) : m.to
      return from && to ? [{ ...m, from, to } as Mark] : []
    }
    if ((m.kind === 'badge' || m.kind === 'check' || m.kind === 'cross') && typeof m.at === 'string') {
      const b = look(m.at)
      if (!b) return []
      const r = BADGE_PT / ppu
      return [{ ...m, at: b[0] > 2 * r ? [b[0] - r, b[1] + b[3] / 2] : [b[0] + b[2] + r, b[1] + b[3] / 2] }]
    }
    if (m.kind === 'arrow' && (typeof m.from === 'string' || typeof m.to === 'string')) {
      const fromBox = typeof m.from === 'string' ? look(m.from) : null
      const toBox = typeof m.to === 'string' ? look(m.to) : null
      if ((typeof m.from === 'string' && !fromBox) || (typeof m.to === 'string' && !toBox)) return []
      const from = fromBox ? centre(fromBox) : (m.from as Point)
      const to = toBox ? centre(toBox) : (m.to as Point)
      return [{ ...m, from: fromBox ? edge(fromBox, to) : from, to: toBox ? edge(toBox, from) : to }]
    }
    return [m as Mark]
  })
  return { marks: placed, missing: [...new Set(missing)] }
}
