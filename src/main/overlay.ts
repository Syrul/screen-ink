// The overlay: one transparent, click-through window that sits over a whole display, above everything.
import { BrowserWindow, type Display } from 'electron'
import path from 'node:path'
import type { DrawPayload } from '../shared/marks'

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
  win.setIgnoreMouseEvents(true)
  // Keep our own ink out of screenshots where macOS honours it; capture also hides the window (see hiddenWhile).
  win.setContentProtection(true)
  loaded = win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  return win
}

/** Moves the overlay over `display` and draws. */
export async function draw(display: Display, payload: DrawPayload): Promise<void> {
  const w = overlayWindow()
  await loaded
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
