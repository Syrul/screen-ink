// screen-ink: a menu-bar app that serves the MCP tools, owns the overlay, and answers the ask shortcut.
import { app, clipboard, globalShortcut, Menu, nativeImage, shell, Tray } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEMO_CAPTION, DEMO_FIGURE_CAPTION, DEMO_FIGURE_MARKS, DEMO_MARKS, DEMO_SIZE } from '../shared/demo'
import * as ask from './ask'
import { displayUnderCursor } from './capture'
import { CLEAR_SHORTCUT, PORT } from './config'
import { startMcp } from './mcp'
import * as listen from './listen'
import * as overlay from './overlay'
import * as sense from './sense'
import * as settings from './settings'
import * as settingsWindow from './settings-window'
import * as update from './update'
import * as voice from './voice'

let tray: Tray | null = null

function loadToken(): { token: string; file: string } {
  const file = path.join(app.getPath('userData'), 'token')
  try {
    const token = fs.readFileSync(file, 'utf8').trim()
    if (token) return { token, file }
  } catch {}
  const token = randomBytes(24).toString('base64url')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, token, { mode: 0o600 })
  return { token, file }
}

/** The menu-bar item is the ✎ title on a Mac; elsewhere it needs a picture. */
function trayIcon(): Electron.NativeImage {
  if (process.platform === 'darwin') return nativeImage.createEmpty()
  return nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'))
}

function drawDemo(figure = false): void {
  const d = displayUnderCursor()
  const demo = figure ? { marks: DEMO_FIGURE_MARKS, caption: DEMO_FIGURE_CAPTION, fadeAfter: 15 } : { marks: DEMO_MARKS, caption: DEMO_CAPTION, fadeAfter: 8 }
  void overlay.draw(d, { ...demo, ppu: d.size.width / DEMO_SIZE.width, ink: settings.get().ink })
}

if (!app.requestSingleInstanceLock()) app.quit()

app.on('window-all-closed', () => {}) // a menu-bar app: keep running with no windows

app.whenReady().then(() => {
  app.dock?.hide()
  const { token, file } = loadToken()
  const url = `http://127.0.0.1:${PORT}/mcp`
  // In zsh or bash on a Mac or Linux, in PowerShell on Windows.
  const read = process.platform === 'win32' ? `Get-Content '${file}'` : `cat '${file}'`
  const addCommand = `claude mcp add --transport http screen-ink ${url} --header "Authorization: Bearer $(${read})"`

  startMcp({ port: PORT, token }).on('error', e => {
    console.error(`screen-ink: can't serve on ${url}: ${e.message}`)
    app.quit()
  })
  const toggleAsk = () => void ask.toggle()
  const clearInk = () => {
    ask.stop()
    overlay.clear()
  }
  // The ask shortcut, moved when the setting changes; the old one stays if the new one can't be had.
  let asking = ''
  const registerAsk = (accelerator: string): boolean => {
    if (accelerator === asking) return true
    let ok = false
    try {
      ok = globalShortcut.register(accelerator, toggleAsk)
    } catch {} // not an accelerator Electron knows
    if (!ok) return false
    if (asking) globalShortcut.unregister(asking)
    asking = accelerator
    return true
  }
  if (!registerAsk(settings.get().hotkey)) {
    console.error(`screen-ink: ${settings.get().hotkey} is taken by another app; pick another shortcut in Settings.`)
  }
  globalShortcut.register(CLEAR_SHORTCUT, clearInk)
  settingsWindow.init({ mcp: { url, command: addCommand }, registerAsk })
  void voice.load()
  void listen.load()
  sense.start()

  tray = new Tray(trayIcon())
  if (process.platform === 'darwin') tray.setTitle('✎')
  tray.setToolTip('screen-ink')
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Ask about the screen…', accelerator: asking || undefined, click: toggleAsk },
      { label: 'Clear', accelerator: CLEAR_SHORTCUT, click: clearInk },
      { label: 'Draw demo', click: () => drawDemo() },
      { label: 'Draw 3D demo', click: () => drawDemo(true) },
      { type: 'separator' },
      { label: 'Speak answers', type: 'checkbox', checked: voice.isOn(), click: item => voice.setOn(item.checked) },
      { label: 'Listen when the bar opens', type: 'checkbox', checked: listen.isOn(), click: item => listen.setOn(item.checked) },
      { label: 'Caption what it says', type: 'checkbox', checked: overlay.captionsOn(), click: item => overlay.setCaptions(item.checked) },
      { label: 'Pen sounds', type: 'checkbox', checked: overlay.soundsOn(), click: item => overlay.setSounds(item.checked) },
      { type: 'separator' },
      { label: 'Copy "claude mcp add" command', click: () => clipboard.writeText(addCommand) },
      ...(update.available()
        ? [{ label: `Download screen-ink ${update.available()!.version}…`, click: () => void shell.openExternal(update.available()!.url) }]
        : []),
      { label: 'Settings…', accelerator: 'CommandOrControl+,', click: settingsWindow.open },
      { type: 'separator' },
      { label: 'Quit screen-ink', role: 'quit' },
    ])
  tray.setContextMenu(menu())
  settings.onChange(() => tray?.setContextMenu(menu())) // checkboxes follow changes made in Settings
  update.watch(() => tray?.setContextMenu(menu()))
  if (!settings.get().onboarded) {
    settingsWindow.open() // the first run: what to allow, and who answers
    settings.set({ onboarded: true })
  }

  console.log(`screen-ink: MCP on ${url}, ask with ${asking}\nAdd it to Claude Code with:\n  ${addCommand}`)
  if (process.env.SCREEN_INK_DEMO) void voice.load().then(() => drawDemo(process.env.SCREEN_INK_DEMO === '3d'))
})

app.on('will-quit', () => globalShortcut.unregisterAll())
