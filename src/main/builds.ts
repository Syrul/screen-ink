// Building along with instructions. screen-ink fetches a LEGO set's building instructions from LEGO (or takes an
// instructions PDF on this Mac), finds the steps in it (instructions.ts), and shows them one at a time in a panel on
// the side of the screen, saying what each asks while the user builds. Next and Back are on the panel, in the bar
// ("next", "back", "step 12") and in the build tool for agents. Questions asked meanwhile come with the step's page,
// so "where does this piece go?" is answered about it. Claude reads the pages once in the background and writes a line
// for each step (which pieces, where they go); until then a step says its number and how many parts it takes.
//
// Each build is a folder in the builds folder of the app's data: its PDFs, what was found in them and how far the
// user got, and pages drawn as they are needed. LEGO's PDFs are for the user's own use: fetched to this Mac, never
// sent anywhere but to the model that reads them.
import { app, type Display } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BuildMove, BuildPanel } from '../shared/build'
import * as brain from './brain'
import { displayUnderCursor } from './capture'
import { read, type Page, type View } from './instructions'
import * as overlay from './overlay'
import * as sense from './sense'

const LEGO_PAGE = (set: string) => `https://www.lego.com/en-us/service/building-instructions/${set}`
const LEGO_PDF = /^https:\/\/www\.lego\.com\/cdn\/product-assets\/[\w./-]+\.pdf$/
const SET = /^\d{3,7}(-\d{1,2})?$/
const MAX_PDF_BYTES = 300e6
const FETCH_MS = 180_000
const PANEL_WIDTH = 1800 // pixels a page is drawn at for the panel
const LOOK_WIDTH = 1000 // and for Claude to read
const PAGES_PER_LOOK = 8 // pages Claude reads at once
const MAX_SAY = 300

export interface Source {
  /** A LEGO set number, like 60285. */
  set?: string
  /** A PDF of instructions on this Mac, in the user's home folder. */
  file?: string
}

interface Build {
  id: string
  title: string
  /** The set number or file it came from. */
  source: string
  books: number
  /** Each booklet's page sizes, in points. */
  sizes: [number, number][][]
  views: (View & { say?: string })[]
  /** The view being shown. */
  at: number
  /** When it was last moved, as an ISO date and time. */
  updated: string
}

export type Summary = Pick<Build, 'id' | 'title' | 'updated'> & { label: string }

const root = () => path.join(app.getPath('userData'), 'builds')
const folder = (id: string) => path.join(root(), id)
const pdf = (id: string, book: number) => path.join(folder(id), `book${book + 1}.pdf`)
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

let current: Build | null = null
const listeners = new Set<() => void>()

/** Calls `fn` when a build opens, moves or closes. */
export const onChange = (fn: () => void) => void listeners.add(fn)
const changed = () => listeners.forEach(fn => fn())

/** Whether a build is open. */
export const active = () => current !== null

// ---- Finding the instructions

type Booklet = { isAdditionalInfoBooklet?: boolean; sequence?: { element?: string }; pdf?: { pdfUrl?: string } }
type SetData = { name?: string; buildingInstructions: Booklet[] }

/** The set in the data LEGO's page carries: the first object in it that lists building instructions. */
function setData(o: unknown): SetData | null {
  if (!o || typeof o !== 'object') return null
  if (Array.isArray((o as SetData).buildingInstructions)) return o as SetData
  for (const v of Object.values(o)) {
    const found = setData(v)
    if (found) return found
  }
  return null
}

/** A LEGO set's building instructions: its name and its booklets' PDFs, in order, from LEGO's page for it. */
async function lego(set: string): Promise<{ title: string; pdfs: string[] }> {
  const res = await fetch(LEGO_PAGE(set), { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) screen-ink' } })
  if (!res.ok) throw new Error(`LEGO's instructions page for ${set} answered ${res.status}.`)
  const html = await res.text()
  let f: SetData | null = null
  try {
    f = setData(JSON.parse(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? 'null'))
  } catch {}
  const booklets = (f?.buildingInstructions ?? [])
    .filter(b => !b.isAdditionalInfoBooklet)
    .sort((a, b) => Number(a.sequence?.element ?? 0) - Number(b.sequence?.element ?? 0))
    .map(b => b.pdf?.pdfUrl ?? '')
  // The page's links, if its data has moved.
  const pdfs = (booklets.length ? booklets : [...new Set(html.match(/https:\/\/www\.lego\.com\/cdn\/product-assets\/product\.bi\.core\.pdf\/\d+\.pdf/g) ?? [])]).filter(u =>
    LEGO_PDF.test(u),
  )
  if (!pdfs.length) throw new Error(`LEGO has no building instructions for set ${set}.`)
  return { title: f?.name ? `${f.name} (${set})` : `LEGO ${set}`, pdfs }
}

/** Saves the PDF at `url` (LEGO's, only) to `file`. */
async function download(url: string, file: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) screen-ink' } })
  if (!LEGO_PDF.test(res.url) || !res.ok) throw new Error(`Couldn't fetch ${url} (${res.status}).`)
  if (Number(res.headers.get('content-length')) > MAX_PDF_BYTES) throw new Error(`${url} is too big.`)
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length
    if (size > MAX_PDF_BYTES) throw new Error(`${url} is too big.`)
    chunks.push(chunk)
  }
  const data = Buffer.concat(chunks)
  if (data.subarray(0, 5).toString() !== '%PDF-') throw new Error(`${url} isn't a PDF.`)
  fs.writeFileSync(file, data)
}

/** A PDF file the user named: one in their home folder. */
function local(file: string): string {
  const home = os.homedir()
  const p = path.resolve(file.replace(/^~(?=$|\/)/, home))
  if (!p.startsWith(home + path.sep) || !/\.pdf$/i.test(p) || !fs.statSync(p, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${file} isn't a PDF in your home folder.`)
  }
  return p
}

/** Fetches and reads the instructions for `src`, unless they were read before. */
async function load(src: Source, status: (text: string) => void): Promise<Build> {
  const set = src.set?.trim().replace(/-\d+$/, '')
  if (set !== undefined && !SET.test(set)) throw new Error(`${src.set} isn't a LEGO set number.`)
  const file = set ? null : src.file ? local(src.file) : null
  if (!set && !file) throw new Error('Name a LEGO set number or an instructions PDF.')
  const id = set ? `lego-${set}` : `file-${hash(file!)}`
  const saved = loadSaved(id)
  if (saved) return saved

  fs.mkdirSync(folder(id), { recursive: true })
  let title: string
  let books: number
  if (set) {
    status(`Finding the instructions for ${set}…`)
    const found = await lego(set)
    title = found.title
    books = found.pdfs.length
    for (const [i, url] of found.pdfs.entries()) {
      status(books > 1 ? `Fetching booklet ${i + 1} of ${books}…` : 'Fetching the instructions…')
      await download(url, pdf(id, i))
    }
  } else {
    title = path.basename(file!, path.extname(file!))
    books = 1
    fs.copyFileSync(file!, pdf(id, 0))
  }
  status('Reading the steps…')
  const pages: Page[][] = []
  for (let i = 0; i < books; i++) {
    const words = await sense.pdfWords(pdf(id, i))
    if (!words) throw new Error(process.platform === 'darwin' ? "Couldn't read the PDF." : 'Reading instructions needs macOS for now.')
    pages.push(words)
  }
  const { views } = read(pages)
  if (!views.length) throw new Error('The PDF has no pages to show.')
  const sizes = pages.map(book => book.map(p => p.size))
  const build: Build = { id, title, source: set ?? file!, books, sizes, views, at: 0, updated: new Date().toISOString() }
  save(build)
  return build
}

function loadSaved(id: string): Build | null {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(folder(id), 'build.json'), 'utf8')) as Build
    return b.id === id && Array.isArray(b.views) && b.views.length && Array.isArray(b.sizes) ? b : null
  } catch {
    return null
  }
}

function save(b: Build): void {
  b.updated = new Date().toISOString()
  fs.writeFileSync(path.join(folder(b.id), 'build.json'), JSON.stringify(b))
}

/** The builds started, the latest first. */
export function list(): Summary[] {
  let names: string[] = []
  try {
    names = fs.readdirSync(root())
  } catch {}
  return names
    .flatMap(id => {
      const b = loadSaved(id)
      return b ? [{ id: b.id, title: b.title, updated: b.updated, label: label(b, b.at) }] : []
    })
    .sort((a, b) => b.updated.localeCompare(a.updated))
}

// ---- Showing a step

const lastStep = (b: Build, book: number) => Math.max(0, ...b.views.filter(v => v.book === book && !v.between).map(v => v.step))

function label(b: Build, i: number): string {
  const v = b.views[i]
  const book = b.books > 1 ? `Book ${v.book + 1} · ` : ''
  if (!v.between) return `${book}Step ${v.step} of ${lastStep(b, v.book)}`
  if (i === b.views.length - 1) return 'Finished'
  return v.step ? `${book}After step ${v.step}` : `${book}Before step 1`
}

/** What a step says until Claude has read it. */
function plain(v: View): string | undefined {
  if (v.between) return undefined
  const parts = v.parts ? ` ${v.parts} part${v.parts === 1 ? '' : 's'}.` : ''
  return `Step ${v.step}.${parts}${v.times ? ` Build it ${v.times} times.` : ''}`
}

/** What the panel reads out for view `i`. */
function said(b: Build, i: number): string | undefined {
  const v = b.views[i]
  if (!v.say) return plain(v)
  return v.between ? v.say : `Step ${v.step}. ${v.say}`
}

/** A page drawn `width` pixels wide, drawn now if it hasn't been. */
async function pageFile(b: Build, book: number, page: number, width: number): Promise<string | null> {
  const file = path.join(folder(b.id), 'pages', `${book + 1}-${page + 1}-${width}.jpg`)
  if (fs.existsSync(file)) return file
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return (await sense.pdfPage(pdf(b.id, book), page, width, file)) ? file : null
}

/** Where the panel goes: with the ink (one window carries both), else under the mouse. */
const display = (): Display => overlay.showing() ?? displayUnderCursor()

async function show(status?: string): Promise<void> {
  const b = current
  const d = display()
  if (!b) return void overlay.showBuild(d, null)
  const i = b.at
  const v = b.views[i]
  const base = { title: b.title, label: label(b, i), index: i, total: b.views.length }
  if (status) return void overlay.showBuild(d, { ...base, status })
  const file = await pageFile(b, v.book, v.page, PANEL_WIDTH)
  if (current !== b || b.at !== i) return // moved on meanwhile
  const panel: BuildPanel = {
    ...base,
    image: file ? `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}` : undefined,
    say: said(b, i),
    parts: v.parts,
    times: v.times,
    ...(file ? {} : { status: "Couldn't draw this page." }),
  }
  const size = b.sizes[v.book]?.[v.page]
  if (v.crop && size) panel.crop = [v.crop[0] / size[0], v.crop[1] / size[1], v.crop[2] / size[0], v.crop[3] / size[1]]
  await overlay.showBuild(d, panel)
  // The next page, ready for Next.
  const next = b.views[i + 1]
  if (next) void pageFile(b, next.book, next.page, PANEL_WIDTH)
}

// ---- Opening, moving and closing

/**
 * Opens the instructions for `src` at `step` (else where the user got to), fetching and reading them first if
 * they're new. Resolves what is showing; throws, saying why, if they can't be had.
 */
export async function open(src: Source, step?: number): Promise<string> {
  current = null
  const status = (text: string) => void overlay.showBuild(display(), { title: 'Building instructions', label: '', index: 0, total: 1, status: text })
  let b: Build
  try {
    b = await load(src, status)
  } catch (e) {
    status((e as Error).message)
    setTimeout(() => !current && void overlay.showBuild(display(), null), 6000)
    throw e
  }
  current = b
  if (step !== undefined) goTo(step)
  save(b)
  await show()
  changed()
  void describe(b)
  return where()
}

/** Shows a build started before, where the user got to. */
export async function resume(id: string): Promise<boolean> {
  const b = loadSaved(id)
  if (!b) return false
  current = b
  await show()
  changed()
  void describe(b)
  return true
}

/** Moves to step `n`, or the first view of it. Resolves whether the build has one. */
function goTo(n: number): boolean {
  const b = current!
  const i = n === 0 ? 0 : b.views.findIndex(v => !v.between && v.step === n)
  if (i < 0) return false
  b.at = i
  return true
}

/** Moves the open build, or closes it. Resolves what is showing, or null if no build is open or there's no such step. */
export async function go(move: BuildMove | number): Promise<string | null> {
  const b = current
  if (!b) return null
  if (move === 'close') {
    close()
    return 'Closed the instructions.'
  }
  if (typeof move === 'number') {
    if (!goTo(move)) return null
  } else if (move === 'next') b.at = Math.min(b.at + 1, b.views.length - 1)
  else if (move === 'back') b.at = Math.max(b.at - 1, 0)
  save(b)
  await show()
  if (move === 'again') overlay.sayBuild(said(b, b.at))
  changed()
  return where()
}

/** Puts the panel away. The build keeps where the user got to. */
export function close(): void {
  if (!current) return
  current = null
  void show()
  changed()
}

/** What is showing, in words, for an agent or the menu. */
export function where(): string {
  const b = current
  if (!b) return 'No instructions are open.'
  const s = said(b, b.at)
  return `Showing ${label(b, b.at).toLowerCase()} of ${b.title} (view ${b.at + 1} of ${b.views.length})${s ? `: ${s}` : '.'}`
}

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
}

/**
 * Takes a question typed or said in the bar that moves the build ("next", "go back", "step 12", "say that again",
 * "stop building"). Resolves whether it was one.
 */
export async function command(question: string): Promise<boolean> {
  if (!current) return false
  const q = question.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim().replace(/ please$/, '')
  if (/^(next|next step|next one|done|ok|okay|got it|continue|go on|forward)$/.test(q)) return !!(await go('next'))
  if (/^(back|go back|previous|previous step|last step|step back)$/.test(q)) return !!(await go('back'))
  if (/^(again|repeat|repeat that|say (it|that) again|what was that)$/.test(q)) return !!(await go('again'))
  if (/^(stop|close|end|quit|exit|hide)( the)? (build|building|instructions)$/.test(q)) return !!(await go('close'))
  const step = /^(go to |show |show me )?step (\d+|[a-z]+)$/.exec(q)?.[2]
  const n = step === undefined ? undefined : /^\d+$/.test(step) ? Number(step) : NUMBERS[step]
  return n !== undefined && !!(await go(n))
}

/** The step's page and what it is, for a question asked while building. Null when no build is showing. */
export async function context(): Promise<{ note: string; jpeg: Buffer } | null> {
  const b = current
  if (!b) return null
  const v = b.views[b.at]
  const file = await pageFile(b, v.book, v.page, LOOK_WIDTH)
  if (!file) return null
  const part = v.crop ? ` The step is the ${side(v)} part of that page.` : ''
  const s = said(b, b.at)
  return {
    note:
      `The user is building ${b.title} from its instructions and is on ${label(b, b.at).toLowerCase()}${s ? ` (${s})` : ''}. ` +
      `screen-ink shows that step's page in a panel on their screen, which the screenshot leaves out; the other image is the page.${part} ` +
      'Answer questions about the build from it (which piece, where it goes, what changed), in the caption or a note: marks land ' +
      'on the screenshot, not on the page. To move them to another step, they say next, back or a step number.',
    jpeg: fs.readFileSync(file),
  }
}

function side(v: View): string {
  if (!v.crop) return 'whole'
  const [x, y] = v.crop
  return x > 1 ? 'right' : y > 1 ? 'lower' : v.crop[2] < v.crop[3] ? 'left' : 'upper'
}

overlay.onBuild(move => void go(move))

// ---- Claude reads the pages

const LOOK = `You read pages of LEGO-style building instructions for someone building along by ear while they look at
their bricks. For each view listed with a page, write what to say for it: one or two short spoken sentences on what
to do, naming the pieces by colour, shape and size in studs (a black two by four plate, a blue slope) and where they
go on the model so far. For a page between steps, say what it shows (open bag 2, put the two halves together, turn
the model around, the finished model). When a step is built more than once, say so. Plain words for speech: no
symbols, no "x" for times, and don't say the step or page number.`

const LOOK_SCHEMA = {
  type: 'object',
  properties: {
    views: {
      type: 'array',
      items: {
        type: 'object',
        properties: { view: { type: 'integer' }, say: { type: 'string', maxLength: MAX_SAY } },
        required: ['view', 'say'],
      },
    },
  },
  required: ['views'],
}

let reading: string | null = null // the build Claude is reading

/** Has Claude write each view's words, a few pages at a time, from the one showing on. */
async function describe(b: Build): Promise<void> {
  if (reading === b.id) return
  reading = b.id
  const tried = new Set<string>()
  try {
    for (;;) {
      const live = current
      if (live?.id !== b.id) break // closed, or another build opened: it carries on when it's shown again
      // The next pages not yet read, from the one showing, so a jump ahead is read next.
      const pages: [number, number][] = []
      for (let k = 0; k < live.views.length && pages.length < PAGES_PER_LOOK; k++) {
        const v = live.views[(live.at + k) % live.views.length]
        const key = `${v.book}-${v.page}`
        if (v.say !== undefined || tried.has(key)) continue
        tried.add(key)
        pages.push([v.book, v.page])
      }
      if (!pages.length) break
      const content: unknown[] = []
      const asked = new Set<number>()
      for (const [book, page] of pages) {
        const file = await pageFile(live, book, page, LOOK_WIDTH)
        if (!file) continue
        const here = live.views.flatMap((v, n) => (v.book === book && v.page === page ? [n] : []))
        here.forEach(n => asked.add(n))
        content.push(
          { type: 'text', text: `Page with ${here.map(n => `view ${n}: ${what(live, n)}`).join('; ')}` },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(file).toString('base64') } },
        )
      }
      if (!content.length) continue
      content.push({ type: 'text', text: `These pages are from the instructions for ${live.title}. Write what to say for each view listed.` })
      const out = (await brain.once(content, LOOK_SCHEMA, LOOK)) as { views?: { view: number; say: string }[] } | null
      if (!out?.views) break // no Claude to read them (Codex answers), or it failed: the steps go without
      const now = current?.id === live.id ? current : live
      for (const { view, say } of out.views) {
        if (asked.has(view) && typeof say === 'string' && say.trim()) now.views[view].say = say.trim().slice(0, MAX_SAY)
      }
      save(now)
      if (current === now && asked.has(now.at)) await show()
    }
  } catch {
    // the build was put away meanwhile, or its folder went: the steps go without
  } finally {
    reading = null
  }
}

function what(b: Build, n: number): string {
  const v = b.views[n]
  if (v.between) return n === b.views.length - 1 ? 'the last page' : v.step ? `a page after step ${v.step}` : 'a page before the first step'
  const part = v.crop ? ` (the ${side(v)} part of the page)` : ''
  return `step ${v.step}${part}${v.times ? `, built ${v.times} times` : ''}${v.parts ? `, ${v.parts} parts` : ''}`
}
