// The shortcut: screenshot the display under the mouse, open a prompt bar on it, ask Claude, draw the answer.
// The screenshot is taken before the bar opens, so neither the bar nor an old drawing is in it. The bar goes as
// soon as the first mark is written and the rest are drawn as they come. Opening the bar again soon after continues
// the conversation; ⌘N in the bar starts a new one. The bar listens as it opens, so the question can be spoken.
// An answer can be the first step of a walkthrough: it names what to click, and once the user clicks there the screen
// is looked at again and the next step drawn, until the task is done or the user moves on.
import { BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { words } from '../shared/caption'
import type { Box, MarkInput } from '../shared/marks'
import * as brain from './brain'
import * as canvas from './canvas'
import { capture, displayUnderCursor, type Capture } from './capture'
import { ANSWER_SECONDS } from './config'
import * as listen from './listen'
import * as overlay from './overlay'
import * as sense from './sense'

export type AskState =
  | { state: 'idle'; followUp?: boolean; listen?: boolean; note?: string }
  | { state: 'thinking'; note?: string }
  | { state: 'error'; message: string }
  | { state: 'closed' }

const SIZE = { width: 640, height: 132 }
const WALK_STEPS = 12 // the most steps one walkthrough takes
const WALK_WAIT_MS = 5 * 60_000 // how long a step waits for its click
const SETTLE_MS = 700 // after the click, for the menu or pane it opens to appear
const CLICK_SLOP_PT = 8 // a click this close to the target counts

let win: BrowserWindow | null = null
let loaded: Promise<void> = Promise.resolve()
let shot: Capture | null = null
let running: AbortController | null = null // the question being answered
let latest: AbortController | null = null // the last answer, which may still be drawing

function bar(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}), // floats over full-screen apps without taking focus
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
  latest?.abort(NEW_QUESTION) // a new question interrupts an answer still being written or drawn
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

const NEW_QUESTION = 'new question' // why an answer was stopped, when the conversation goes on

/** Stops the answer being drawn, and the walkthrough it may have started. */
export function stop(): void {
  latest?.abort()
}

/** Asks Claude and draws the answer as it is written, then walks through the steps that follow it, if any. */
async function answer(question: string, shot: Capture, keep: boolean): Promise<void> {
  const abort = (running = latest = new AbortController())
  let next = await reply(question, shot, keep, abort)
  running = null
  try {
    for (let step = 1; next !== undefined && step <= WALK_STEPS && !abort.signal.aborted; step++) {
      brain.warm() // keep the conversation while the user finds the click
      const where = await clicked(next, shot, abort.signal)
      // A step nobody clicked goes after a while; one whose click can't be seen stays as long as an answer does.
      if (where === 'timeout') overlay.clear()
      if (where === 'blind') setTimeout(() => latest === abort && !abort.signal.aborted && overlay.clear(), ANSWER_SECONDS * 1000)
      if (typeof where !== 'object' || !where) break
      overlay.clear(true)
      await new Promise(r => setTimeout(r, SETTLE_MS))
      if (abort.signal.aborted) break
      shot = await capture(shot.display)
      canvas.remember(shot)
      next = await reply(
        `I clicked it${where.on ? ` (${where.on})` : ''}. This is the screen now: show the next step, or say it's done and leave out next.`,
        shot,
        false,
        abort,
      )
    }
  } catch (e) {
    if (!abort.signal.aborted) queue(abort, { marks: [], caption: `Stopped: ${(e as Error).message}`, speakCaption: false, fadeAfter: ANSWER_SECONDS })
  } finally {
    // A new question carries the conversation on; otherwise it waits for a follow-up as usual.
    if (next !== undefined && abort.signal.reason !== NEW_QUESTION) brain.idle()
  }
}

type Click = { on: string } | 'timeout' | 'blind' | null

/**
 * Waits for a click on `target` (a box in `shot`'s units, or one of its element ids), and resolves the clicked
 * element's words. Or 'timeout' if none comes in time, 'blind' if clicks can't be watched, null if the target is
 * unknown or the walk is stopped.
 */
async function clicked(target: Box | string, shot: Capture, signal: AbortSignal): Promise<Click> {
  const element = typeof target === 'string' ? (await shot.elements).find(e => e.id === target) : undefined
  const box = typeof target === 'string' ? element?.box : target
  if (!box || signal.aborted) return null
  const { x, y } = shot.display.bounds
  const [left, top] = [x + box[0] * shot.ppu - CLICK_SLOP_PT, y + box[1] * shot.ppu - CLICK_SLOP_PT]
  const [right, bottom] = [left + box[2] * shot.ppu + 2 * CLICK_SLOP_PT, top + box[3] * shot.ppu + 2 * CLICK_SLOP_PT]
  return new Promise(resolve => {
    let settled = false
    let unwatch: (() => void) | null = null
    const finish = (v: Click) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      unwatch?.()
      resolve(v)
    }
    const aborted = () => finish(null)
    const timer = setTimeout(() => finish('timeout'), WALK_WAIT_MS)
    signal.addEventListener('abort', aborted, { once: true })
    void sense
      .watchClicks(([cx, cy]) => cx >= left && cx <= right && cy >= top && cy <= bottom && finish({ on: element?.text ?? '' }))
      .then(stop => {
        if (!stop) {
          console.log('screen-ink: allow Accessibility to be walked through steps; ask again for the next one meanwhile.')
          return finish('blind')
        }
        if (settled) stop()
        else unwatch = stop
      })
  })
}

// Each mark is drawn as it arrives, in order; drawings wait for the ones before them.
let drawing: Promise<unknown> = Promise.resolve()
function queue(abort: AbortController, d: canvas.Drawing): Promise<unknown> {
  return (drawing = drawing.then(async () => abort.signal.aborted || (await canvas.draw(d))).catch(() => {}))
}

/**
 * Asks Claude and draws the answer as it is written. `keep` adds it to what is on screen instead of replacing it.
 * Resolves what to click for the next step of a walkthrough, if the answer has one.
 */
async function reply(question: string, shot: Capture, keep: boolean, abort: AbortController): Promise<Box | string | undefined> {
  send({ state: 'thinking' })

  // The first mark replaces whatever was there, the rest add to it.
  let caption: string | undefined
  let streamed = 0
  let captionRead = false // whether a drawing so far has had the caption to read out
  const onMark = (mark: MarkInput) => {
    if (abort.signal.aborted) return
    if (streamed++) return queue(abort, { marks: [mark], append: true, speakCaption: false })
    hide()
    // Marks that carry their own words are narrated; otherwise the caption is read over them.
    captionRead = !words(mark).length && caption !== undefined
    queue(abort, { marks: [mark], caption, append: keep, speakCaption: captionRead })
  }

  try {
    const answer = await brain.ask(question, shot, abort.signal, {
      onStep: note => !abort.signal.aborted && send({ state: 'thinking', note }),
      onCaption: c => (caption = c),
      onMark,
    })
    if (abort.signal.aborted) return
    running = null
    hide()
    await queue(abort, {
      marks: answer.marks.slice(streamed),
      caption: answer.caption,
      append: keep || streamed > 0,
      speakCaption: !captionRead && !answer.marks.some(m => words(m).length),
      fadeAfter: answer.next === undefined ? ANSWER_SECONDS : undefined, // a step stays until it is done
    })
    return answer.next as Box | string | undefined
  } catch (e) {
    if (abort.signal.aborted) return
    running = null
    const message = (e as Error).message
    if (streamed || keep || !win?.isVisible()) queue(abort, { marks: [], caption: `Stopped: ${message}`, append: true, speakCaption: false, fadeAfter: ANSWER_SECONDS })
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
