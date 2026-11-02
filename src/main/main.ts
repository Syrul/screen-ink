// screen-ink: a menu-bar app that serves the MCP tools, owns the overlay, and answers the ask shortcut.
import { app, clipboard, globalShortcut, Menu, nativeImage, Tray } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEMO_CAPTION, DEMO_FIGURE_CAPTION, DEMO_FIGURE_MARKS, DEMO_MARKS, DEMO_SIZE } from '../shared/demo'
import * as ask from './ask'
import { displayUnderCursor } from './capture'
import { ASK_SHORTCUT, CLEAR_SHORTCUT, INK, PORT } from './config'
import { startMcp } from './mcp'
import * as listen from './listen'
import * as overlay from './overlay'
import * as sense from './sense'
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

function drawDemo(figure = false): void {
  const d = displayUnderCursor()
  const demo = figure ? { marks: DEMO_FIGURE_MARKS, caption: DEMO_FIGURE_CAPTION, fadeAfter: 15 } : { marks: DEMO_MARKS, caption: DEMO_CAPTION, fadeAfter: 8 }
  void overlay.draw(d, { ...demo, ppu: d.size.width / DEMO_SIZE.width, ink: INK })
}

if (!app.requestSingleInstanceLock()) app.quit()

app.on('window-all-closed', () => {}) // a menu-bar app: keep running with no windows

app.whenReady().then(() => {
  app.dock?.hide()
  const { token, file } = loadToken()
  const url = `http://127.0.0.1:${PORT}/mcp`
  const addCommand = `claude mcp add --transport http screen-ink ${url} --header "Authorization: Bearer $(cat '${file}')"`

  startMcp({ port: PORT, token }).on('error', e => {
    console.error(`screen-ink: can't serve on ${url}: ${e.message}`)
    app.quit()
  })
  const toggleAsk = () => void ask.toggle()
  const clearInk = () => {
    ask.stop()
    overlay.clear()
  }
  if (!globalShortcut.register(ASK_SHORTCUT, toggleAsk)) {
    console.error(`screen-ink: ${ASK_SHORTCUT} is taken by another app; set SCREEN_INK_HOTKEY to another shortcut.`)
  }
  globalShortcut.register(CLEAR_SHORTCUT, clearInk)
  void voice.load()
  void listen.load()
  sense.start()

  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('✎')
  tray.setToolTip('screen-ink')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ask about the screen…', accelerator: ASK_SHORTCUT, click: toggleAsk },
      { label: 'Clear', accelerator: CLEAR_SHORTCUT, click: clearInk },
      { label: 'Draw demo', click: () => drawDemo() },
      { label: 'Draw 3D demo', click: () => drawDemo(true) },
      { label: 'Speak answers', type: 'checkbox', checked: voice.isOn(), click: item => voice.setOn(item.checked) },
      { label: 'Listen when the bar opens', type: 'checkbox', checked: listen.isOn(), click: item => listen.setOn(item.checked) },
      { label: 'Caption what it says', type: 'checkbox', checked: overlay.captionsOn(), click: item => overlay.setCaptions(item.checked) },
      { label: 'Pen sounds', type: 'checkbox', checked: overlay.soundsOn(), click: item => overlay.setSounds(item.checked) },
      { type: 'separator' },
      { label: `MCP on ${url}`, enabled: false },
      { label: 'Copy "claude mcp add" command', click: () => clipboard.writeText(addCommand) },
      { type: 'separator' },
      { label: 'Quit screen-ink', role: 'quit' },
    ]),
  )

  console.log(`screen-ink: MCP on ${url}, ask with ${ASK_SHORTCUT}\nAdd it to Claude Code with:\n  ${addCommand}`)
  if (process.env.SCREEN_INK_DEMO) void voice.load().then(() => drawDemo(process.env.SCREEN_INK_DEMO === '3d'))
})

app.on('will-quit', () => globalShortcut.unregisterAll())
