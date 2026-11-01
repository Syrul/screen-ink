// The overlay: one transparent, click-through window that sits over a whole display, above everything.
import { BrowserWindow, ipcMain, type Display } from 'electron'
import path from 'node:path'
import { speaksCaption, words } from '../shared/caption'
import type { DrawPayload } from '../shared/marks'
import { CAPTIONS } from './config'
import * as voice from './voice'

const FIRST_WORDS_WAIT_MS = 1500 // the most a drawing waits for its first words to be ready

let win: BrowserWindow | null = null
let loaded: Promise<void> = Promise.resolve()

function overlayWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    type: 'panel',
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    fullscreenable: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Clicks go through to the apps below, but moves still reach the page, so it can take the mouse while it is over
  // a figure's card (to turn it or ask about a part) and let it go again after.
  win.setIgnoreMouseEvents(true, { forward: true })
  // Keep our own ink out of screenshots where macOS honours it; capture also hides the window (see hiddenWhile).
  win.setContentProtection(true)
  loaded = win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  return win
}

ipcMain.on('ink:pointer', (e, over: unknown) => {
  if (win && !win.isDestroyed() && e.sender === win.webContents) win.setIgnoreMouseEvents(over !== true, { forward: true })
})

/** The overlay page, to check who is talking. */
export const page = () => (win && !win.isDestroyed() ? win.webContents : null)

let captions = CAPTIONS
export const captionsOn = () => captions
export function setCaptions(value: boolean): void {
  captions = value
}

// The page asks for each mark's words as it draws; the answer comes once they are said. Meanwhile it is told when
// they start and how long they take, to caption them.
ipcMain.handle('ink:speak', (e, text: unknown) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents || typeof text !== 'string') return
  const page = win.webContents
  return voice.speak(text, seconds => captions && !page.isDestroyed() && page.send('ink:saying', { text, seconds }))
})

/** Moves the overlay over `display` and draws. */
export async function draw(display: Display, payload: DrawPayload): Promise<void> {
  const w = overlayWindow()
  if (!payload.append) {
    voice.stop()
    voice.forget()
  }
  // Render the words ahead, and start once the first are ready.
  const lines = [...payload.marks.flatMap(words), ...(speaksCaption(payload) ? [payload.caption!] : [])]
  const first = voice.prepare(lines)
  await Promise.all([loaded, Promise.race([first, new Promise(r => setTimeout(r, FIRST_WORDS_WAIT_MS))])])
  const b = display.bounds
  const cur = w.getBounds()
  if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) {
    // A drawing on another display can't carry over: start fresh there.
    if (w.isVisible()) w.webContents.send('ink:clear', { instant: true })
    w.setBounds(b)
  }
  w.showInactive()
  w.webContents.send('ink:draw', payload)
}

export function clear(instant = false): void {
  voice.stop()
  voice.forget()
  if (win && !win.isDestroyed()) win.webContents.send('ink:clear', { instant })
}

/** Runs `fn` with the overlay invisible, so a screenshot shows the screen and not our marks. */
export async function hiddenWhile<T>(fn: () => Promise<T>): Promise<T> {
  if (!win || win.isDestroyed() || !win.isVisible()) return fn()
  win.setOpacity(0)
  await new Promise(r => setTimeout(r, 60))
  try {
    return await fn()
  } finally {
    win.setOpacity(1)
  }
}
