// Lessons: drawings kept to show again. The last drawing, with whatever was added to it after, can be saved from the
// menu or by an agent, and shown again later on any display, scaled to fit, its words said again as it draws. Each is
// a JSON file in the lessons folder of the app's data.
import { app, type Display } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { DrawPayload, Mark } from '../shared/marks'

export interface Lesson {
  id: string
  title: string
  /** When it was saved, as an ISO date and time. */
  at: string
  /** The width of the display it was drawn on, in screen points. */
  width: number
  caption?: string
  /** The marks in drawing order, each with the screen points per unit it was drawn at. */
  pieces: { mark: Mark; ppu: number }[]
}

export type Summary = Pick<Lesson, 'id' | 'title' | 'at'>

const PROGRESS = 'progress' // a hand-off's checklist is news, not part of the lesson
const MAX = 100

const dir = () => path.join(app.getPath('userData'), 'lessons')
const fileOf = (id: string) => path.join(dir(), `${id}.json`)

// ---- The drawing on screen now, as it would be saved

let current: { displayId: number; width: number; caption?: string; pieces: Lesson['pieces'] } | null = null

/** Follows what the overlay draws. */
export function track(display: Display, p: DrawPayload): void {
  const marks = p.marks.filter(m => m.id !== PROGRESS)
  if (p.append && !marks.length && !p.remove?.length && !p.caption) return
  const fresh = !p.append || !current || current.displayId !== display.id
  const replaced = new Set([...(p.remove ?? []), ...marks.flatMap(m => (m.id ? [m.id] : []))])
  const kept = fresh ? [] : current!.pieces.filter(x => !(x.mark.id && replaced.has(x.mark.id)))
  current = {
    displayId: display.id,
    width: display.size.width,
    caption: p.caption ?? (fresh ? undefined : current!.caption),
    pieces: [...kept, ...marks.map(mark => ({ mark, ppu: p.ppu }))],
  }
}

/** Whether there is a drawing to save. */
export const canSave = () => Boolean(current?.pieces.length)

// ---- Saved lessons

let index: Summary[] | null = null
const listeners = new Set<() => void>()

/** Calls `fn` whenever a lesson is saved or deleted. */
export const onChange = (fn: () => void) => void listeners.add(fn)
const changed = () => {
  index = null
  for (const fn of listeners) fn()
}

/** The saved lessons, newest first. */
export function list(): Summary[] {
  if (!index) {
    let names: string[] = []
    try {
      names = fs.readdirSync(dir()).filter(n => n.endsWith('.json'))
    } catch {}
    index = names
      .flatMap((n): Summary[] => {
        try {
          const l = JSON.parse(fs.readFileSync(path.join(dir(), n), 'utf8')) as Lesson
          return typeof l.id === 'string' && typeof l.title === 'string' ? [{ id: l.id, title: l.title, at: l.at }] : []
        } catch {
          return []
        }
      })
      .sort((a, b) => b.at.localeCompare(a.at))
  }
  return index
}

/** A title from the drawing's own words, when it isn't given one. */
function titleFor(c: NonNullable<typeof current>): string {
  for (const { mark } of c.pieces) if ('title' in mark && typeof mark.title === 'string' && mark.title) return mark.title
  if (c.caption) return c.caption.length > 60 ? `${c.caption.slice(0, 57).trimEnd()}…` : c.caption
  return `Drawing of ${new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
}

/** Saves the current drawing. Resolves the lesson, or null when nothing has been drawn. */
export function save(title?: string): Summary | null {
  if (!current?.pieces.length) return null
  if (list().length >= MAX) throw new Error(`There are already ${MAX} lessons. Delete some in Settings first.`)
  const lesson: Lesson = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: title?.trim().slice(0, 80) || titleFor(current),
    at: new Date().toISOString(),
    ...current,
  }
  delete (lesson as Partial<typeof current>).displayId
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(fileOf(lesson.id), JSON.stringify(lesson), { mode: 0o600 })
  changed()
  return { id: lesson.id, title: lesson.title, at: lesson.at }
}

export function remove(id: string): void {
  if (!/^[a-z0-9]+$/.test(id)) return
  fs.rmSync(fileOf(id), { force: true })
  changed()
}

/** A lesson as drawings to send in order on `display`: its marks scaled to fit, the first replacing what is there. */
export function drawings(id: string, display: Display): Omit<DrawPayload, 'ink'>[] | null {
  if (!/^[a-z0-9]+$/.test(id)) return null
  let l: Lesson
  try {
    l = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'))
  } catch {
    return null
  }
  const scale = display.size.width / l.width
  // Marks drawn at the same scale go together; a new drawing starts wherever it changed.
  const out: Omit<DrawPayload, 'ink'>[] = []
  for (const { mark, ppu } of l.pieces) {
    const last = out.at(-1)
    if (last && last.ppu === ppu * scale) last.marks.push(mark)
    else out.push({ marks: [mark], ppu: ppu * scale, append: out.length > 0 })
  }
  if (out.length) out[0].caption = l.caption
  return out
}
