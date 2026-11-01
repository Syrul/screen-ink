// The shortcut: screenshot the display under the mouse, open a prompt bar on it, ask Claude, draw the answer.
// The screenshot is taken before the bar opens, so neither the bar nor an old drawing is in it.
import { BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { askClaude } from './brain'
import * as canvas from './canvas'
import { capture, displayUnderCursor, type Capture } from './capture'
import { ANSWER_SECONDS } from './config'
import * as overlay from './overlay'

export type AskState = { state: 'idle' } | { state: 'thinking'; note?: string } | { state: 'error'; message: string }

const SIZE = { width: 640, height: 132 }

let win: BrowserWindow | null = null
let loaded: Promise<void> = Promise.resolve()
let shot: Capture | null = null
let running: AbortController | null = null

function bar(): BrowserWindow {
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
    skipTaskbar: true,
    fullscreenable: false,
    ...SIZE,
    webPreferences: {
      preload: path.join(__dirname, 'ask-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.on('blur', () => !running && close())
  loaded = win.loadFile(path.join(__dirname, 'renderer', 'ask.html'))
  return win
}

function send(state: AskState): void {
  if (win && !win.isDestroyed()) win.webContents.send('ask:state', state)
}

function close(): void {
  running?.abort()
  running = null
  shot = null
  if (win && !win.isDestroyed()) win.hide()
}

/** The shortcut's handler: opens the bar, or closes it when it is already open. */
export async function toggle(): Promise<void> {
  if (win?.isVisible()) return close()
  overlay.clear(true)
  const display = displayUnderCursor()
  const w = bar()
  const { x, y, width, height } = display.workArea
  w.setBounds({ x: Math.round(x + (width - SIZE.width) / 2), y: Math.round(y + height * 0.22), ...SIZE })
  try {
    shot = await capture(display)
    canvas.remember(shot)
    await loaded
    send({ state: 'idle' })
  } catch (e) {
    await loaded
    send({ state: 'error', message: `Couldn't see the screen: ${(e as Error).message}` })
  }
  w.show()
  w.focus()
}

ipcMain.on('ask:submit', async (_e, question: unknown) => {
  if (!shot || running || typeof question !== 'string' || !question.trim()) return
  const abort = (running = new AbortController())
  send({ state: 'thinking' })
  try {
    const answer = await askClaude(question.trim(), shot, abort.signal, note => !abort.signal.aborted && send({ state: 'thinking', note }))
    if (abort.signal.aborted) return
    running = null
    close()
    await canvas.draw({ ...answer, fadeAfter: ANSWER_SECONDS })
  } catch (e) {
    if (abort.signal.aborted) return
    running = null
    send({ state: 'error', message: (e as Error).message })
  }
})

ipcMain.on('ask:cancel', close)
