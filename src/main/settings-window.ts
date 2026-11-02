// The Settings window, which is also the first-run setup: what macOS must allow, whether the model that answers is
// signed in, the choices in settings.ts, what is remembered, saved lessons, connecting an agent over MCP, and the
// licence.
import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, shell, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import * as canvas from './canvas'
import { screenAccess } from './capture'
import * as lessons from './lessons'
import * as licence from './licence'
import * as memory from './memory'
import * as settings from './settings'
import type { Settings } from './settings'

export interface Status {
  screen: string
  accessibility: boolean
  microphone: string
  /** Whether the model that answers is ready, and what to tell the user about it. */
  provider: { ok: boolean; text: string }
}

export interface View {
  settings: Settings
  status: Status
  keyHint: string | null
  mcp: { url: string; command: string }
  licence: licence.LicenceState
  memories: memory.Memory[]
  lessons: lessons.Summary[]
  version: string
  platform: string
}

// System Settings panes the window may open, by what they're for.
const PANES: Record<string, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
}

let win: BrowserWindow | null = null
let hooks: { mcp: View['mcp']; registerAsk: (accelerator: string) => boolean } | null = null

/** Gives the window what it can't work out itself. Call once, at startup. */
export function init(h: NonNullable<typeof hooks>): void {
  hooks = h
}

export function open(): void {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }
  win = new BrowserWindow({
    width: 640,
    height: 760,
    minWidth: 520,
    minHeight: 480,
    title: 'screen-ink Settings',
    show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', vibrancy: 'sidebar', backgroundColor: '#00000000' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => {
    win?.show()
    app.focus({ steal: true }) // a menu-bar app isn't in front by itself
  })
  win.on('closed', () => (win = null))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', e => e.preventDefault())
  void win.loadFile(path.join(__dirname, 'renderer', 'settings.html'))
}

const from = (e: Electron.IpcMainInvokeEvent) => !!win && !win.isDestroyed() && e.sender === win.webContents

/** Runs a command briefly and resolves its exit code and output. */
function run(command: string, args: string[]): Promise<{ code: number | string; out: string }> {
  return new Promise(resolve =>
    execFile(command, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as NodeJS.ErrnoException).code ?? 1) : 0, out: `${stdout}${stderr}`.trim() }),
    ),
  )
}

async function providerStatus(s: Settings): Promise<Status['provider']> {
  if (s.provider === 'api-key') {
    return settings.apiKey()
      ? { ok: true, text: 'Claude Code answers with your API key, billed to your Anthropic account.' }
      : { ok: false, text: 'Paste your Anthropic API key below.' }
  }
  const command = s.provider === 'codex' ? s.codex : s.claude
  const { code, out } = await run(command, s.provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'])
  if (code === 'ENOENT') {
    const name = s.provider === 'codex' ? 'Codex' : 'Claude Code'
    return { ok: false, text: `Can't find ${name} ("${command}"). Install it, or set its full path below.` }
  }
  if (s.provider === 'codex') {
    return code === 0 ? { ok: true, text: `Codex is ready: ${out.split('\n')[0]}.` } : { ok: false, text: 'Codex isn\'t signed in. Run "codex login" in a terminal.' }
  }
  try {
    const a = JSON.parse(out)
    if (!a.loggedIn) return { ok: false, text: 'Claude Code isn\'t signed in. Run "claude auth login" in a terminal.' }
    const plan = a.subscriptionType ? `your ${a.subscriptionType} plan` : a.authMethod === 'claude.ai' ? 'your Claude account' : 'its login'
    return { ok: true, text: `Claude Code is signed in and answers on ${plan}.` }
  } catch {
    return code === 0 ? { ok: true, text: 'Claude Code is installed.' } : { ok: false, text: 'Claude Code didn\'t say whether it is signed in. Run "claude auth status".' }
  }
}

async function view(): Promise<View> {
  const s = settings.get()
  const key = s.provider === 'api-key' ? settings.apiKey() : null
  const mac = process.platform === 'darwin'
  return {
    settings: { ...s },
    status: {
      screen: screenAccess(),
      accessibility: mac ? systemPreferences.isTrustedAccessibilityClient(false) : true,
      microphone: mac || process.platform === 'win32' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted',
      provider: await providerStatus(s),
    },
    keyHint: key ? `…${key.slice(-4)}` : null,
    mcp: hooks!.mcp,
    licence: licence.state(s.licence),
    memories: memory.list(),
    lessons: lessons.list(),
    version: app.getVersion(),
    platform: process.platform,
  }
}

ipcMain.handle('settings:view', e => (from(e) ? view() : null))

// Changes that only take effect after a restart.
const ON_RESTART: (keyof Settings)[] = ['voice']

ipcMain.handle('settings:set', (e, patch: unknown) => {
  if (!from(e) || !patch || typeof patch !== 'object') return { ok: false }
  const p = patch as Partial<Settings>
  if (typeof p.hotkey === 'string' && !settings.isShortcut(p.hotkey)) {
    return { ok: false, message: `${p.hotkey} isn't a shortcut: write it like Alt+Shift+Space, with at least one of Command, Control, Alt or Shift.` }
  }
  if (typeof p.hotkey === 'string' && p.hotkey !== settings.get().hotkey && !hooks!.registerAsk(p.hotkey)) {
    return { ok: false, message: `Another app has ${p.hotkey}. Try another shortcut.` }
  }
  const before = settings.get()
  const after = settings.set(p)
  const changed = (Object.keys(p) as (keyof Settings)[]).filter(k => after[k] !== before[k])
  if ((Object.keys(p) as (keyof Settings)[]).some(k => after[k] !== p[k])) return { ok: false, message: "That value isn't allowed." }
  return { ok: true, restart: changed.some(k => ON_RESTART.includes(k)) }
})

ipcMain.handle('settings:key', (e, key: unknown) => {
  if (!from(e) || (key !== null && typeof key !== 'string')) return false
  return settings.setApiKey(key)
})

ipcMain.handle('settings:licence', (e, key: unknown) => {
  if (!from(e) || typeof key !== 'string') return null
  const now = licence.state(key)
  if (now.state === 'licensed' || !key.trim()) settings.set({ licence: key.trim() })
  return now
})

// Asks macOS for a permission, the first time, and opens its pane in System Settings.
ipcMain.handle('settings:grant', async (e, what: unknown) => {
  if (!from(e) || typeof what !== 'string' || !(what in PANES)) return
  if (process.platform !== 'darwin') return
  if (what === 'screen') await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {})
  if (what === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true)
  if (what === 'microphone' && systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
    if (await systemPreferences.askForMediaAccess('microphone')) return
  }
  await shell.openExternal(PANES[what])
})

ipcMain.handle('settings:forget', (e, id: unknown) => {
  if (from(e) && (id === null || typeof id === 'string')) memory.forget(id)
})

ipcMain.handle('settings:lesson', async (e, id: unknown, what: unknown) => {
  if (!from(e) || typeof id !== 'string') return
  if (what === 'show') await canvas.showLesson(id)
  else if (what === 'delete') lessons.remove(id)
})

ipcMain.handle('settings:copy', (e, text: unknown) => {
  if (from(e) && typeof text === 'string' && text.length < 2000) clipboard.writeText(text)
})

ipcMain.handle('settings:link', (e, url: unknown) => {
  if (from(e) && typeof url === 'string' && /^https:\/\//.test(url)) void shell.openExternal(url)
})

ipcMain.handle('settings:relaunch', e => {
  if (!from(e)) return
  app.relaunch()
  app.exit(0)
})
