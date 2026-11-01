// The shortcut: screenshot the display under the mouse, open a prompt bar on it, ask Claude, draw the answer.
// The screenshot is taken before the bar opens, so neither the bar nor an old drawing is in it. The bar goes as
// soon as the first mark is written and the rest are drawn as they come. Opening the bar again soon after continues
// the conversation; ⌘N in the bar starts a new one. The bar listens as it opens, so the question can be spoken.
import { BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { words } from '../shared/caption'
import type { MarkInput } from '../shared/marks'
import * as brain from './brain'
import * as canvas from './canvas'
import { capture, displayUnderCursor, type Capture } from './capture'
import { ANSWER_SECONDS } from './config'
import * as listen from './listen'
import * as overlay from './overlay'

export type AskState =
  | { state: 'idle'; followUp?: boolean; listen?: boolean; note?: string }
  | { state: 'thinking'; note?: string }
  | { state: 'error'; message: string }
  | { state: 'closed' }

const SIZE = { width: 640, height: 132 }

let win: BrowserWindow | null = null
let loaded: Promise<void> = Promise.resolve()
let shot: Capture | null = null
let running: AbortController | null = null // the question being answered
let latest: AbortController | null = null // the last answer, which may still be drawing

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

/** Puts the bar away; an answer being written carries on. */
function hide(): void {
  shot = null
  send({ state: 'closed' }) // stops the microphone
  if (win && !win.isDestroyed()) win.hide()
}

/** Puts the bar away and drops the question in it. */
function close(): void {
  const asking = running
  running?.abort()
  running = null
  hide()
  if (!asking) brain.idle()
}

/** The shortcut's handler: opens the bar, or closes it when it is already open. */
export async function toggle(): Promise<void> {
  if (win?.isVisible()) return close()
  latest?.abort() // a new question interrupts an answer still being written or drawn
  running = null
  overlay.clear(true)
  brain.warm()
  const display = displayUnderCursor()
  const w = bar()
  const { x, y, width, height } = display.workArea
  w.setBounds({ x: Math.round(x + (width - SIZE.width) / 2), y: Math.round(y + height * 0.22), ...SIZE })
  try {
    shot = await capture(display)
    canvas.remember(shot)
    await loaded
    send({ state: 'idle', followUp: brain.followingUp(), ...(await hearing()) })
  } catch (e) {
    await loaded
    send({ state: 'error', message: `Couldn't see the screen: ${(e as Error).message}` })
  }
  w.show()
  w.focus()
}

ipcMain.on('ask:submit', (_e, question: unknown) => {
  if (!shot || running || typeof question !== 'string' || !question.trim()) return
  void answer(question.trim(), shot, false)
})

/** Asks about a part the user clicked in a figure. The answer is drawn beside the figure, which stays. */
export async function askAbout(question: string): Promise<void> {
  if (running || win?.isVisible()) return
  try {
    const shot = await capture(displayUnderCursor())
    canvas.remember(shot)
    await answer(question, shot, true)
  } catch (e) {
    await canvas.draw({ marks: [], caption: `Couldn't ask: ${(e as Error).message}`, append: true, fadeAfter: ANSWER_SECONDS }).catch(() => {})
  }
}

ipcMain.on('ink:ask', (e, question: unknown) => {
  if (e.sender === overlay.page() && typeof question === 'string' && question.trim()) void askAbout(question.trim().slice(0, 400))
})

/** Asks Claude and draws the answer as it is written. `keep` adds it to what is on screen instead of replacing it. */
async function answer(question: string, shot: Capture, keep: boolean): Promise<void> {
  const abort = (running = latest = new AbortController())
  send({ state: 'thinking' })

  // Each mark is drawn as it arrives, in order: the first replaces whatever was there, the rest add to it.
  let drawing: Promise<unknown> = Promise.resolve()
  const queue = (d: canvas.Drawing) => (drawing = drawing.then(async () => abort.signal.aborted || (await canvas.draw(d))).catch(() => {}))
  let caption: string | undefined
  let streamed = 0
  let captionRead = false // whether a drawing so far has had the caption to read out
  const onMark = (mark: MarkInput) => {
    if (abort.signal.aborted) return
    if (streamed++) return queue({ marks: [mark], append: true, speakCaption: false })
    hide()
    // Marks that carry their own words are narrated; otherwise the caption is read over them.
    captionRead = !words(mark).length && caption !== undefined
    queue({ marks: [mark], caption, append: keep, speakCaption: captionRead })
  }

  try {
    const answer = await brain.askClaude(question, shot, abort.signal, {
      onStep: note => !abort.signal.aborted && send({ state: 'thinking', note }),
      onCaption: c => (caption = c),
      onMark,
    })
    if (abort.signal.aborted) return
    running = null
    hide()
    queue({
      marks: answer.marks.slice(streamed),
      caption: answer.caption,
      append: keep || streamed > 0,
      speakCaption: !captionRead && !answer.marks.some(m => words(m).length),
      fadeAfter: ANSWER_SECONDS,
    })
    await drawing
  } catch (e) {
    if (abort.signal.aborted) return
    running = null
    const message = (e as Error).message
    if (streamed || keep) queue({ marks: [], caption: `Stopped: ${message}`, append: true, speakCaption: false, fadeAfter: ANSWER_SECONDS })
    else send({ state: 'error', message })
  }
}

/** Whether the bar should listen, or why it can't. */
async function hearing(): Promise<{ listen: boolean; note?: string }> {
  if (!listen.ready()) return { listen: false }
  if (await listen.microphone()) return { listen: true }
  return { listen: false, note: 'The microphone is off for screen-ink: turn it on in System Settings → Privacy & Security → Microphone.' }
}

listen.serve(() => (win && !win.isDestroyed() ? win.webContents : null))

ipcMain.on('ask:cancel', close)

ipcMain.on('ask:new', () => {
  if (running) return
  brain.reset()
  brain.warm()
  send({ state: 'idle', followUp: false, listen: false })
})
