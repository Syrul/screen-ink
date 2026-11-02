// The shortcut: screenshot the display under the mouse, open a prompt bar on it, ask Claude, draw the answer.
// The screenshot is taken before the bar opens, so neither the bar nor an old drawing is in it. The bar goes as
// soon as the first mark is written and the rest are drawn as they come. Opening the bar again soon after continues
// the conversation; ⌘N in the bar starts a new one. The bar listens as it opens, so the question can be spoken.
// An answer can be the first step of a walkthrough: it names what to click, and once the user clicks there the screen
// is looked at again and the next step drawn, until the task is done or the user moves on. Or the user lets
// screen-ink click the steps itself ("Do it for me"): each step is drawn and said first, then pressed through the
// Accessibility API, except a step that can't be taken back, which is left for the user to click.
// While the user builds along with instructions (builds.ts), "next" or "step 12" in the bar moves them, and a
// question comes with the step's page.
import { BrowserWindow, ipcMain, systemPreferences } from 'electron'
import path from 'node:path'
import { words } from '../shared/caption'
import type { Box, MarkInput, Point } from '../shared/marks'
import type { Scroll } from './answer'
import * as brain from './brain'
import * as builds from './builds'
import * as canvas from './canvas'
import { capture, displayUnderCursor, type Capture } from './capture'
import { ANSWER_SECONDS } from './config'
import * as listen from './listen'
import * as overlay from './overlay'
import * as sense from './sense'
import * as settings from './settings'
import * as voice from './voice'

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
const SHOW_MS = 1200 // the least a step screen-ink does stays up before it is pressed, so the user sees what
const SAID_MS = 10_000 // the most a step waits for its words to be said before it is pressed
const SCROLL_SHARE = 0.7 // how much of the screen a scroll moves, when the answer doesn't say
const SCROLLED_MS = 700 // the user's scrolling is over once it has stopped this long
// Words on a button, menu item, link or checkbox that mean the user decides, whatever the answer says. Rows, tabs,
// menu titles and fields only lead somewhere, so their words don't count.
const LEADS = new Set(['AXRow', 'AXOutlineRow', 'AXCell', 'AXTab', 'AXStaticText', 'AXHeading', 'AXImage', 'AXMenuBarItem', 'AXDisclosureTriangle'])
const YOURS =
  /\b(send|buy|purchase|pay|order|check ?out|delete|remove|erase|trash|discard|don'?t save|confirm|submit|post|publish|share|sign (in|out|up)|log ?(in|out)|password|transfer|install|uninstall|update|upgrade|restart|shut ?down|reset|format|allow|accept|agree|subscribe|unsubscribe|replace|overwrite|quit|ok)\b/i

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

ipcMain.on('ask:submit', async (_e, question: unknown) => {
  const asked = shot
  if (!asked || running || typeof question !== 'string' || !question.trim()) return
  // While building, "next", "back" or "step 12" moves the instructions instead of asking.
  if (builds.active() && (await builds.command(question.trim()))) return close()
  if (!running) void answer(question.trim(), asked, false)
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

let doing: AbortController | null = null // the walkthrough screen-ink is clicking for the user
let takeOver: (() => void) | null = null // hands the step the user is waiting on to screen-ink

// The walkthrough's buttons: "Do it for me" on a step, "Stop" while screen-ink is doing the steps.
overlay.onWalk(start => {
  if (!start) {
    const was = doing !== null
    doing = null
    return was
  }
  if (!takeOver) return false
  takeOver()
  return true
})

/** Stops the answer being drawn, and the walkthrough it may have started. */
export function stop(): void {
  latest?.abort()
}

/** Asks Claude and draws the answer as it is written, then walks through the steps that follow it, if any. */
async function answer(question: string, shot: Capture, keep: boolean): Promise<void> {
  const abort = (running = latest = new AbortController())
  let step = await reply(question, shot, keep, abort)
  running = null
  try {
    for (let n = 1; walks(step) && n <= WALK_STEPS && !abort.signal.aborted; n++) {
      brain.warm() // keep the conversation while the user finds the click
      let done: Done = null
      while (!abort.signal.aborted) {
        if (doing === abort) {
          const did = step.scroll ? await scrollFor(step.scroll, shot, abort) : await pressFor(step.next!, step.final, shot, abort)
          if (typeof did === 'object') {
            done = did
            break
          }
          // Refused, or the user pressed Stop: either way the step is theirs, and the Stop button goes.
          const refused = doing === abort
          doing = null
          queue(abort, {
            marks: [],
            remove: ['walk'],
            append: true,
            ...(refused ? { caption: `This one is yours: ${did}. Click it when you're ready.`, speakCaption: true } : { speakCaption: false }),
          })
        } else if (offers() && !step.final) {
          queue(abort, { marks: [await walkButton('Do it for me', 'start', step, shot)], append: true, speakCaption: false })
        }
        done = step.scroll ? await scrolled(abort.signal) : await clicked(step.next!, shot, abort.signal)
        if (done !== 'auto') break
        doing = abort
        queue(abort, { marks: [await walkButton('Stop', 'stop', step, shot)], append: true, speakCaption: false })
      }
      // A step nobody did goes after a while; one whose click can't be seen stays as long as an answer does.
      if (done === 'timeout') overlay.clear()
      if (done === 'blind') setTimeout(() => latest === abort && !abort.signal.aborted && overlay.clear(), ANSWER_SECONDS * 1000)
      if (typeof done !== 'object' || !done) break
      overlay.clear(true)
      await new Promise(r => setTimeout(r, SETTLE_MS))
      if (abort.signal.aborted) break
      shot = await capture(shot.display)
      canvas.remember(shot)
      step = await reply(`${done.said}. This is the screen now: show the next step, or say it's done and leave out next and scroll.`, shot, false, abort)
      if (doing === abort && walks(step)) queue(abort, { marks: [await walkButton('Stop', 'stop', step, shot)], append: true, speakCaption: false })
    }
  } catch (e) {
    if (!abort.signal.aborted) queue(abort, { marks: [], caption: `Stopped: ${(e as Error).message}`, speakCaption: false, fadeAfter: ANSWER_SECONDS })
  } finally {
    if (doing === abort) doing = null
    // A new question carries the conversation on; otherwise it waits for a follow-up as usual.
    if (walks(step) && abort.signal.reason !== NEW_QUESTION) brain.idle()
  }
}

/** A walkthrough's step, as an answer gives it: something to click, or somewhere to scroll. */
type Step = { next?: Box | string; scroll?: Scroll & { at?: Box | string }; final?: boolean }
const walks = (s: { next?: unknown; scroll?: unknown }) => s.next !== undefined || s.scroll !== undefined

/** What came of a step: what happened, as the model is told it, or why there is nothing to tell. */
type Done = { said: string } | 'auto' | 'timeout' | 'blind' | null

/** Whether a walkthrough step offers to be done for the user. */
const offers = () => settings.get().doIt && process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false)

/** A target as a box in the screenshot's units, and the element it names, if it names one. */
async function locate(target: Box | string, shot: Capture): Promise<{ box?: Box; element?: sense.Element }> {
  if (typeof target !== 'string') return { box: target }
  const element = (await shot.elements).find(e => e.id === target)
  return { box: element?.box, element }
}

/** The middle of a box in the screenshot's units, in global points. */
function global(box: Box, shot: Capture): Point {
  const { x, y } = shot.display.bounds
  return [x + (box[0] + box[2] / 2) * shot.ppu, y + (box[1] + box[3] / 2) * shot.ppu]
}

/** A global point as screen-ink's pointer takes it: points on the overlay's display. */
const local = ([px, py]: Point, shot: Capture): [number, number] => [px - shot.display.bounds.x, py - shot.display.bounds.y]

/** The walkthrough's own button, at the bottom of the screen, or the top when the step is down there. */
async function walkButton(text: string, value: 'start' | 'stop', step: Step, shot: Capture): Promise<MarkInput> {
  const target = step.next ?? step.scroll?.at
  const { box } = target === undefined ? {} : await locate(target, shot)
  const low = !!box && box[1] + box[3] > shot.height * 0.7
  return { kind: 'action', id: 'walk', text, do: 'walk', value, at: [shot.width / 2 - 55, low ? 60 : shot.height - 150] }
}

/** Lets a step be seen, and its words said, before screen-ink does it. Resolves whether it is still screen-ink's to do. */
async function shown(abort: AbortController): Promise<boolean> {
  const started = Date.now()
  await new Promise(r => setTimeout(r, SHOW_MS))
  while (voice.speaking() && Date.now() - started < SAID_MS && !abort.signal.aborted) await new Promise(r => setTimeout(r, 150))
  return !abort.signal.aborted && doing === abort
}

/**
 * Presses `target` for the user once its step has been seen and said. Resolves what was pressed, or why the step
 * is the user's to click: it can't be taken back, the helper can't press it, or the user stopped screen-ink.
 */
async function pressFor(target: Box | string, final: boolean | undefined, shot: Capture, abort: AbortController): Promise<Done | string> {
  if (final) return "it can't be taken back"
  const { box, element } = await locate(target, shot)
  if (!box) return "I can't find it on screen"
  const at = global(box, shot)
  const look = await sense.press(at, true)
  if (!look.target) return look.refused ?? "there's nothing there to press"
  const name = look.target.label || element?.text || ''
  const leads = look.target.how === 'focus' || LEADS.has(look.target.role)
  if (!leads && YOURS.test(`${look.target.label} ${element?.text ?? ''}`)) return `“${name}” is for you to decide`
  if (!(await shown(abort))) return 'you took over'
  await overlay.point(local(at, shot), { press: true, label: name || undefined }) // screen-ink's pointer shows the press first
  if (abort.signal.aborted || doing !== abort) return 'you took over'
  const done = await sense.press(at)
  return done.refused ?? { said: `screen-ink pressed it for me${name ? ` (${name})` : ''}` }
}

/** Scrolls for the user once the step has been seen and said. Resolves what was done, or why it wasn't. */
async function scrollFor(s: NonNullable<Step['scroll']>, shot: Capture, abort: AbortController): Promise<Done | string> {
  const { box } = s.at === undefined ? { box: [0, 0, shot.width, shot.height] as Box } : await locate(s.at, shot)
  if (!box) return "I can't find what to scroll"
  const at = global(box, shot)
  const vertical = s.direction === 'down' || s.direction === 'up'
  const points = (s.by ?? SCROLL_SHARE * (vertical ? shot.height : shot.width)) * shot.ppu
  if (!(await shown(abort))) return 'you took over'
  await overlay.point(local(at, shot), { scroll: s.direction })
  if (abort.signal.aborted || doing !== abort) return 'you took over'
  if (!(await sense.scroll(at, s.direction, points))) return 'screen-ink needs Accessibility to scroll'
  return { said: `screen-ink scrolled ${s.direction} for me` }
}

/**
 * Waits on the user: `watch` starts watching and calls `finish` with what they did. Or 'auto' when they hand the
 * step to screen-ink, 'timeout' if they do nothing in time, 'blind' if they can't be watched, null if the walk stops.
 */
function waitFor(watch: (finish: (d: Done) => void) => Promise<(() => void) | null>, signal: AbortSignal): Promise<Done> {
  return new Promise(resolve => {
    let settled = false
    let unwatch: (() => void) | null = null
    const finish = (v: Done) => {
      if (settled) return
      settled = true
      if (takeOver === auto) takeOver = null
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      unwatch?.()
      resolve(v)
    }
    const aborted = () => finish(null)
    const auto = () => finish('auto')
    takeOver = auto
    const timer = setTimeout(() => finish('timeout'), WALK_WAIT_MS)
    if (signal.aborted) return finish(null)
    signal.addEventListener('abort', aborted, { once: true })
    void watch(finish).then(stop => {
      if (!stop) {
        console.log('screen-ink: allow Accessibility to be walked through steps; ask again for the next one meanwhile.')
        return finish('blind')
      }
      if (settled) stop()
      else unwatch = stop
    })
  })
}

/** Waits for a click on `target` (a box in `shot`'s units, or one of its element ids). */
async function clicked(target: Box | string, shot: Capture, signal: AbortSignal): Promise<Done> {
  const { box, element } = await locate(target, shot)
  if (!box || signal.aborted) return null
  const { x, y } = shot.display.bounds
  const [left, top] = [x + box[0] * shot.ppu - CLICK_SLOP_PT, y + box[1] * shot.ppu - CLICK_SLOP_PT]
  const [right, bottom] = [left + box[2] * shot.ppu + 2 * CLICK_SLOP_PT, top + box[3] * shot.ppu + 2 * CLICK_SLOP_PT]
  const said = `I clicked it${element?.text ? ` (${element.text})` : ''}`
  return waitFor(finish => sense.watchClicks(([cx, cy]) => cx >= left && cx <= right && cy >= top && cy <= bottom && finish({ said })), signal)
}

/** Waits for the user to scroll, and for the scrolling to stop. */
function scrolled(signal: AbortSignal): Promise<Done> {
  let quiet: NodeJS.Timeout | undefined
  return waitFor(
    finish =>
      sense.watchScrolls(() => {
        clearTimeout(quiet)
        quiet = setTimeout(() => finish({ said: 'I scrolled' }), SCROLLED_MS)
      }),
    signal,
  )
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
async function reply(question: string, shot: Capture, keep: boolean, abort: AbortController): Promise<Step> {
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
    // While building, the step's page goes along, so "where does this go?" is about it.
    const page = await builds.context().catch(() => null)
    const answer = await brain.ask(
      question,
      shot,
      abort.signal,
      { onStep: note => !abort.signal.aborted && send({ state: 'thinking', note }), onCaption: c => (caption = c), onMark },
      page ?? undefined,
    )
    if (abort.signal.aborted) return {}
    running = null
    hide()
    if (answer.build) void builds.open({ set: answer.build.set }).catch(() => {}) // the panel says why it couldn't
    await queue(abort, {
      marks: answer.marks.slice(streamed),
      caption: answer.caption,
      append: keep || streamed > 0,
      speakCaption: !captionRead && !answer.marks.some(m => words(m).length),
      fadeAfter: walks(answer) ? undefined : ANSWER_SECONDS, // a step stays until it is done
    })
    return { next: answer.next as Box | string | undefined, scroll: answer.scroll as Step['scroll'], final: answer.final }
  } catch (e) {
    if (abort.signal.aborted) return {}
    running = null
    const message = (e as Error).message
    if (streamed || keep || !win?.isVisible()) queue(abort, { marks: [], caption: `Stopped: ${message}`, append: true, speakCaption: false, fadeAfter: ANSWER_SECONDS })
    else send({ state: 'error', message })
    return {}
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
