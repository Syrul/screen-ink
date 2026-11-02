// What the user has chosen, kept in settings.json in the app's data folder and changed from the Settings window or
// the menu. An environment variable set for one launch wins over what is saved, so `SCREEN_INK_VOICE=off npm start`
// is silent whatever the settings say. An API key is kept apart, encrypted with the system keychain.
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const PROVIDERS = ['claude-code', 'api-key', 'codex'] as const
export type Provider = (typeof PROVIDERS)[number]

export interface Settings {
  /** Who answers the shortcut: the installed Claude Code on its login, Claude Code on an API key, or Codex. */
  provider: Provider
  /** The Claude model (an alias like sonnet, or a full id). */
  model: string
  /** low … max, or '' for the CLI's default. */
  effort: '' | (typeof EFFORTS)[number]
  /** Deep mode: figures are checked and fixed before they're drawn. auto is on at high effort and above. */
  check: 'auto' | 'on' | 'off'
  /** Claude Code's built-in tools the shortcut may use, comma-separated. */
  tools: string
  /** The claude and codex commands, or their full paths. */
  claude: string
  codex: string
  /** The Codex model, or '' for its default. */
  codexModel: string
  /** Whether answers are read out, and in which voice (a Kokoro voice, `say` or `say:<macOS voice>`). */
  speak: boolean
  voice: string
  captions: boolean
  listen: boolean
  sounds: boolean
  /** The ink's colour, #rrggbb. */
  ink: string
  /** The ask shortcut, as an Electron accelerator. */
  hotkey: string
  /** Whether the first-run setup has been seen. */
  onboarded: boolean
  /** A licence key, as pasted. */
  licence: string
}

const DEFAULTS: Settings = {
  provider: 'claude-code',
  model: 'sonnet',
  effort: '',
  check: 'auto',
  tools: 'WebSearch',
  claude: 'claude',
  codex: 'codex',
  codexModel: '',
  speak: true,
  voice: 'af_heart',
  captions: true,
  listen: true,
  sounds: true,
  ink: '#FF5A36',
  hotkey: 'Alt+Shift+Space',
  onboarded: false,
  licence: '',
}

// Electron accelerators: modifiers, then one key. A global shortcut needs a modifier, or it would take a key away.
const MODIFIERS = /^(Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)$/i
const KEYS =
  /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|[`~!@#$%^&*()\-=_[\]{};':",.\/<>?\\|])$/i

export function isShortcut(accelerator: string): boolean {
  const parts = accelerator.split('+').map(p => p.trim())
  const key = parts.pop() ?? ''
  return parts.length > 0 && parts.every(p => MODIFIERS.test(p)) && KEYS.test(key)
}

/** Whether `value` may be stored as `key`. */
function valid<K extends keyof Settings>(key: K, value: unknown): value is Settings[K] {
  if (typeof value !== typeof DEFAULTS[key]) return false
  switch (key) {
    case 'provider':
      return PROVIDERS.includes(value as Provider)
    case 'effort':
      return value === '' || EFFORTS.includes(value as (typeof EFFORTS)[number])
    case 'check':
      return ['auto', 'on', 'off'].includes(value as string)
    case 'ink':
      return /^#[0-9a-fA-F]{6}$/.test(value as string)
    case 'model':
    case 'codexModel':
      return /^[\w.:\-[\]]{0,80}$/.test(value as string)
    case 'tools':
      return /^[\w,() *:-]{0,400}$/.test(value as string)
    case 'hotkey':
      return isShortcut(value as string)
    case 'claude':
    case 'codex':
    case 'voice':
      return (value as string).length > 0 && (value as string).length < 400
    default:
      return true
  }
}

/** What this launch's environment says. */
function fromEnv(): Partial<Settings> {
  const env = process.env
  const out: Partial<Record<keyof Settings, unknown>> = {}
  const off = (name: string) => (env[name] === undefined ? undefined : env[name] !== 'off')
  if (env.SCREEN_INK_PROVIDER) out.provider = env.SCREEN_INK_PROVIDER
  if (env.SCREEN_INK_MODEL) out.model = env.SCREEN_INK_MODEL
  if (env.SCREEN_INK_EFFORT) out.effort = env.SCREEN_INK_EFFORT
  if (env.SCREEN_INK_CHECK) out.check = env.SCREEN_INK_CHECK === 'off' ? 'off' : 'on'
  if (env.SCREEN_INK_TOOLS !== undefined) out.tools = env.SCREEN_INK_TOOLS
  if (env.SCREEN_INK_CLAUDE) out.claude = env.SCREEN_INK_CLAUDE
  if (env.SCREEN_INK_CODEX) out.codex = env.SCREEN_INK_CODEX
  if (env.SCREEN_INK_VOICE === 'off') out.speak = false
  else if (env.SCREEN_INK_VOICE) [out.speak, out.voice] = [true, env.SCREEN_INK_VOICE]
  out.captions = off('SCREEN_INK_CAPTIONS')
  out.listen = off('SCREEN_INK_LISTEN')
  out.sounds = off('SCREEN_INK_SOUNDS')
  if (env.SCREEN_INK_COLOR) out.ink = env.SCREEN_INK_COLOR
  if (env.SCREEN_INK_HOTKEY) out.hotkey = env.SCREEN_INK_HOTKEY
  return clean(out, 'environment')
}

/** The entries of `raw` that are settings with valid values; says which aren't. */
function clean(raw: Record<string, unknown>, from: string): Partial<Settings> {
  const out: Partial<Record<keyof Settings, unknown>> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || !(key in DEFAULTS)) continue
    if (valid(key as keyof Settings, value)) out[key as keyof Settings] = value
    else console.error(`screen-ink: ignoring ${key} ${JSON.stringify(value)} from the ${from}.`)
  }
  return out as Partial<Settings>
}

const file = () => path.join(app.getPath('userData'), 'settings.json')
const keyFile = () => path.join(app.getPath('userData'), 'api-key')

function readSaved(): Partial<Settings> {
  try {
    return clean(JSON.parse(fs.readFileSync(file(), 'utf8')), 'settings file')
  } catch {
    return {}
  }
}

let saved = readSaved()
let current: Settings = { ...DEFAULTS, ...saved, ...fromEnv() }
const listeners = new Set<(now: Settings, before: Settings) => void>()

export const get = (): Readonly<Settings> => current

/** Changes settings, saves them, and tells whoever is listening. Invalid values are left out. */
export function set(patch: Partial<Settings>): Readonly<Settings> {
  const ok = clean(patch, 'change')
  if (!Object.keys(ok).length) return current
  const before = current
  current = { ...current, ...ok }
  saved = { ...saved, ...ok }
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(saved, null, 2))
  for (const fn of listeners) fn(current, before)
  return current
}

export function onChange(fn: (now: Settings, before: Settings) => void): void {
  listeners.add(fn)
}

/** Whether deep mode is on now. */
export const checking = (s = current) => s.check === 'on' || (s.check === 'auto' && ['high', 'xhigh', 'max'].includes(s.effort))

// ---- The API key

/** The API key to answer with: ANTHROPIC_API_KEY if this launch has one, else the saved one. */
export function apiKey(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try {
    const sealed = fs.readFileSync(keyFile())
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(sealed) : null
  } catch {
    return null
  }
}

/** Saves an API key, encrypted, or forgets it (null). Resolves whether it could. */
export function setApiKey(key: string | null): boolean {
  if (key === null) {
    fs.rmSync(keyFile(), { force: true })
    return true
  }
  if (!/^sk-ant-[\w-]{20,300}$/.test(key.trim()) || !safeStorage.isEncryptionAvailable()) return false
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true })
  fs.writeFileSync(keyFile(), safeStorage.encryptString(key.trim()), { mode: 0o600 })
  return true
}
