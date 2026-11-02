// What the shortcut remembers about the user between conversations: short facts an answer asks to keep ("uses
// VS Code with the Vim keys", "is new to Blender"), kept in memory.json on this Mac, shown and deletable in Settings,
// and given to the model at the start of each conversation. Off in Settings, nothing is kept or given.
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import * as settings from './settings'

export interface Memory {
  id: string
  text: string
  /** When it was kept, as an ISO date. */
  at: string
}

const MAX = 40 // the oldest go first
const MAX_CHARS = 200

const file = () => path.join(app.getPath('userData'), 'memory.json')
let cache: Memory[] | null = null

export function list(): Memory[] {
  if (!cache) {
    try {
      const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
      cache = Array.isArray(raw) ? raw.filter(m => typeof m?.id === 'string' && typeof m?.text === 'string') : []
    } catch {
      cache = []
    }
  }
  return cache
}

function save(next: Memory[]): void {
  cache = next.slice(-MAX)
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2), { mode: 0o600 })
}

const same = (a: string, b: string) => a.toLowerCase().replace(/\W+/g, ' ').trim() === b.toLowerCase().replace(/\W+/g, ' ').trim()

/** Keeps a fact, unless memory is off or it is already kept. */
export function remember(text: string): void {
  const t = text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS)
  if (!settings.get().memory || !t || list().some(m => same(m.text, t))) return
  save([...list(), { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: t, at: new Date().toISOString().slice(0, 10) }])
}

export function forget(id: string | null): void {
  save(id === null ? [] : list().filter(m => m.id !== id))
}

/** The facts, as the model is told them; empty when there are none or memory is off. */
export function brief(): string {
  if (!settings.get().memory || !list().length) return ''
  return `What you know about the user from earlier conversations (use it when it helps, don't mention it):\n${list()
    .map(m => `- ${m.text}`)
    .join('\n')}`
}
