// screen-ink: a menu-bar app that serves the MCP tools and owns the overlay.
import { app, clipboard, globalShortcut, Menu, nativeImage, Tray } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEMO_CAPTION, DEMO_MARKS, DEMO_SIZE } from '../shared/demo'
import { displayUnderCursor } from './capture'
import { startMcp } from './mcp'
import * as overlay from './overlay'

const PORT = Number(process.env.SCREEN_INK_PORT) || 7377
const INK = /^#[0-9a-fA-F]{6}$/.test(process.env.SCREEN_INK_COLOR ?? '') ? process.env.SCREEN_INK_COLOR! : '#FF5A36'
const CLEAR_SHORTCUT = 'Control+Alt+Escape'

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

function drawDemo(): void {
  const d = displayUnderCursor()
  void overlay.draw(d, { marks: DEMO_MARKS, caption: DEMO_CAPTION, fadeAfter: 8, ppu: d.size.width / DEMO_SIZE.width, ink: INK })
}

if (!app.requestSingleInstanceLock()) app.quit()

app.on('window-all-closed', () => {}) // a menu-bar app: keep running with no windows

app.whenReady().then(() => {
  app.dock?.hide()
  const { token, file } = loadToken()
  const url = `http://127.0.0.1:${PORT}/mcp`
  const addCommand = `claude mcp add --transport http screen-ink ${url} --header "Authorization: Bearer $(cat '${file}')"`

  startMcp({ port: PORT, token, ink: INK }).on('error', e => {
    console.error(`screen-ink: can't serve on ${url}: ${e.message}`)
    app.quit()
  })
  globalShortcut.register(CLEAR_SHORTCUT, overlay.clear)

  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('✎')
  tray.setToolTip('screen-ink')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `MCP on ${url}`, enabled: false },
      { label: 'Copy "claude mcp add" command', click: () => clipboard.writeText(addCommand) },
      { type: 'separator' },
      { label: 'Draw demo', click: drawDemo },
      { label: 'Clear', accelerator: CLEAR_SHORTCUT, click: overlay.clear },
      { type: 'separator' },
      { label: 'Quit screen-ink', role: 'quit' },
    ]),
  )

  console.log(`screen-ink: MCP on ${url}\nAdd it to Claude Code with:\n  ${addCommand}`)
  if (process.env.SCREEN_INK_DEMO) drawDemo()
})

app.on('will-quit', () => globalShortcut.unregisterAll())
