// Where the 3D models of instructions come from: LDraw's Official Model Repository (models of LEGO sets made from
// their booklets, at library.ldraw.org), or a model file on this Mac; and the parts they're made of, fetched one file
// at a time as a model needs them and kept in the ldraw folder of the app's data, so each is fetched once. Parts come
// first from a copy of LDraw's library on GitHub (the one three.js's examples load theirs from: quick, but from 2024),
// then from LDraw's own, which takes a request a second. A model's parts go to the overlay as one packed text (an MPD
// of every file they use), so the page never fetches anything. LDraw's library and models are free to use with
// credit (CC BY).
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse, parts, type Model } from './ldraw'

const SITE = 'https://library.ldraw.org'
const OMR = `${SITE}/omr/sets`
const MODEL_URL = /https:\/\/library\.ldraw\.org\/media\/omr_models\/\d+\/[^"'?<>\s]+\.(?:mpd|ldr)/g
const MIRROR = 'https://raw.githubusercontent.com/gkjohnson/ldraw-parts-library/master/complete/ldraw'
const LIBRARIES = [MIRROR, `${SITE}/library/official`, `${SITE}/library/unofficial`]
const AGENT = { 'user-agent': 'Mozilla/5.0 (Macintosh) screen-ink' }
const FETCH_MS = 30_000
const GAP_MS = 1050 // between requests to LDraw's site, which takes 60 a minute
const BUSY_MS = 61_000 // how long to wait when it says that's too many
const AT_ONCE = 12 // part files fetched together
const MAX_MODEL_BYTES = 20e6
const MAX_FILES = 8000 // part files one model may need

const library = () => path.join(app.getPath('userData'), 'ldraw')

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
let turn: Promise<unknown> = Promise.resolve() // LDraw's site, one request at a time

/** A text file from the web, or null if there's none there. LDraw's own site is asked politely. */
async function get(url: string, tries = 3): Promise<string | null> {
  const once = () => fetch(url, { signal: AbortSignal.timeout(FETCH_MS), headers: AGENT })
  let res: Response
  if (url.startsWith(SITE)) {
    const go = turn.then(once)
    turn = go.then(() => wait(GAP_MS), () => wait(GAP_MS))
    res = await go
  } else res = await once()
  if (res.status === 404) return null
  if (res.status === 429 && tries > 1) {
    const after = Number(res.headers.get('retry-after')) * 1000 || BUSY_MS
    turn = turn.then(() => wait(after))
    return get(url, tries - 1)
  }
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}.`)
  return res.text()
}

// ---- Finding a set's model

/** One page of the repository's list of sets, which is in order of set number: each set's number and page id. */
async function listPage(page: number): Promise<{ sets: { set: string; id: string }[]; total: number }> {
  const html = (await get(`${OMR}?page=${page}`)) ?? ''
  const sets = html
    .split('<tr')
    .slice(1)
    .flatMap(row => {
      const id = /omr\/sets\/(\d+)"/.exec(row)?.[1]
      const set = /(?:^|>)\s*(\d{1,7}-\d{1,2})\s*</.exec(row)?.[1]
      return id && set ? [{ set, id }] : []
    })
  const total = Number(/of\s+([\d,]+)\s+results/.exec(html)?.[1].replace(/,/g, '') ?? 0)
  return { sets, total }
}

/** The repository's model of LEGO set `set` (60285, or 60285-1), found in its list by halving: its URL, or null. */
export async function findModel(set: string): Promise<string | null> {
  const want = /-\d+$/.test(set) ? set : `${set}-1`
  const first = await listPage(1)
  if (!first.sets.length) return null
  let [lo, hi] = [1, Math.ceil(first.total / first.sets.length) || 1]
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const { sets } = mid === 1 ? first : await listPage(mid)
    if (!sets.length) return null
    if (want < sets[0].set) hi = mid - 1
    else if (want > sets.at(-1)!.set) lo = mid + 1
    else {
      const id = sets.find(s => s.set === want)?.id
      if (!id) return null
      const urls = [...((await get(`${OMR}/${id}`)) ?? '').replace(/&amp;/g, '&').matchAll(MODEL_URL)].map(m => m[0])
      return urls.find(u => path.basename(u).startsWith(want)) ?? urls[0] ?? null
    }
  }
  return null
}

/** Saves the repository's model at `url` (theirs only) to `file`, and reads it. */
export async function fetchModel(url: string, file: string): Promise<Model> {
  if (!url.startsWith(`${SITE}/media/omr_models/`)) throw new Error(`${url} isn't one of LDraw's models.`)
  const text = await get(url)
  if (!text || text.length > MAX_MODEL_BYTES) throw new Error("Couldn't fetch the 3D model.")
  fs.writeFileSync(file, text)
  return parse(text)
}

/** A model file the user named, in their home folder: copied to `file`, and read. */
export function copyModel(from: string, file: string): Model {
  const home = os.homedir()
  const p = path.resolve(from.replace(/^~(?=$|\/)/, home))
  const stat = fs.statSync(p, { throwIfNoEntry: false })
  if (!p.startsWith(home + path.sep) || !/\.(ldr|mpd|dat)$/i.test(p) || !stat?.isFile() || stat.size > MAX_MODEL_BYTES) {
    throw new Error(`${from} isn't an LDraw model (.ldr or .mpd) in your home folder.`)
  }
  fs.copyFileSync(p, file)
  return parse(fs.readFileSync(file, 'utf8'))
}

// ---- The parts library

/** The name LDrawLoader looks a file up by, from how a line names it: s\ and 48\ are folders it knows. */
const looked = (name: string) => {
  const n = name.trim().replace(/\\/g, '/').toLowerCase()
  return n.startsWith('s/') ? `parts/${n}` : n.startsWith('48/') ? `p/${n}` : n
}

/** Where a looked-up name may be in the library, in order. */
function places(name: string): string[] {
  if (name.startsWith('parts/') || name.startsWith('p/')) return [name]
  if (/^(8|48)\//.test(name)) return [`p/${name}`]
  return [`parts/${name}`, `p/${name}`]
}

const SAFE = /^[a-z0-9_.\-/]+$/
const NONE = '0 not in the LDraw library' // kept for a file no library has
const RECHECK_MS = 30 * 86_400_000 // before asking for it again

/** A library file: kept, else fetched and kept. Null if no library has it, or none could be asked. */
async function libraryFile(name: string): Promise<string | null> {
  if (!SAFE.test(name) || name.includes('..')) return null
  const kept = path.join(library(), name)
  try {
    const text = fs.readFileSync(kept, 'utf8')
    if (!text.startsWith(NONE)) return text
    if (Date.now() - fs.statSync(kept).mtimeMs < RECHECK_MS) return null
  } catch {}
  let failed = false
  for (const base of LIBRARIES) {
    for (const where of places(name)) {
      const text = await get(`${base}/${where}`).catch(() => ((failed = true), null))
      if (text === null) continue
      fs.mkdirSync(path.dirname(kept), { recursive: true })
      fs.writeFileSync(kept, text)
      return text
    }
  }
  if (!failed) {
    fs.mkdirSync(path.dirname(kept), { recursive: true })
    fs.writeFileSync(kept, NONE)
  }
  return null
}

/** The files a file's lines name. */
const named = (text: string) =>
  text.split(/\r?\n/).flatMap(l => {
    const t = l.trim().split(/\s+/)
    return t[0] === '1' && t.length >= 15 ? [looked(t.slice(14).join(' '))] : []
  })

/**
 * Every part file `model` is made of (its own, and the library's, fetched as needed), packed into one MPD the
 * overlay's loader reads: a first empty model, then each file. A file no library has is packed empty, so the rest
 * still draws. `progress` hears how many files are ready, and how many are known of so far.
 */
export async function pack(model: Model, progress: (done: number, known: number) => void = () => {}): Promise<{ text: string; missing: number }> {
  const texts = new Map<string, string>()
  const own = new Map([...model.own].map(([name, text]) => [looked(name), text]))
  const queue = [...parts(model)].map(looked)
  const seen = new Set(queue)
  let lost = 0
  while (queue.length && texts.size < MAX_FILES) {
    const batch = queue.splice(0, AT_ONCE)
    const got = await Promise.all(batch.map(name => own.get(name) ?? libraryFile(name)))
    batch.forEach((name, i) => {
      if (got[i] === null) lost++
      texts.set(name, got[i] ?? NONE)
      for (const n of named(got[i] ?? '')) if (!seen.has(n)) (seen.add(n), queue.push(n))
    })
    progress(texts.size, seen.size)
  }
  const text = ['0 FILE screen-ink parts.ldr', ...[...texts].map(([name, text]) => `0 FILE ${name}\n${text.trimEnd()}`)].join('\n')
  return { text: text + '\n', missing: lost }
}

/** LDraw's colours: its LDConfig.ldr, kept with the parts. */
export async function colours(): Promise<string> {
  const kept = path.join(library(), 'LDConfig.ldr')
  try {
    return fs.readFileSync(kept, 'utf8')
  } catch {}
  const text = await get(`${LIBRARIES[0]}/LDConfig.ldr`)
  if (!text) throw new Error("Couldn't fetch LDraw's colours.")
  fs.mkdirSync(library(), { recursive: true })
  fs.writeFileSync(kept, text)
  return text
}

/** The colour lines of LDConfig a packed model and its steps use. */
export function usedColours(config: string, ...texts: string[]): string {
  const codes = new Set<string>(['16', '24'])
  for (const text of texts) for (const m of text.matchAll(/^\s*[1-5]\s+(\d+)\s/gm)) codes.add(m[1])
  return config
    .split(/\r?\n/)
    .filter(l => {
      const code = /^0 !COLOUR\s+\S+\s+CODE\s+(\d+)/.exec(l.trim())?.[1]
      return code !== undefined && codes.has(code)
    })
    .join('\n')
}
