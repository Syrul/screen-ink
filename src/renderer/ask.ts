// The prompt bar. It listens as it opens: the words show as they are said, and a pause asks. Typing instead stops
// the listening and leaves what was heard to edit. Enter asks, Esc closes, ⌘N starts a new conversation. Opened in
// a plain browser (no `window.askBridge`) it cycles its states.
import type { AskState } from '../main/ask'
import { Mic } from './mic'

declare global {
  interface Window {
    askBridge?: {
      submit(q: string): void
      cancel(): void
      startOver(): void
      transcribe(samples: Float32Array): Promise<string>
      onState(cb: (s: AskState) => void): void
    }
  }
}

const root = document.getElementById('root') as HTMLElement
const input = document.getElementById('question') as HTMLInputElement
const message = document.getElementById('message') as HTMLDivElement
const hint = document.getElementById('hint') as HTMLSpanElement
const meter = document.getElementById('mic') as HTMLSpanElement

const INTERIM_MS = 600 // how often the words so far are recognized while the question is spoken
const bridge = window.askBridge
let followUp = false
let mic: Mic | null = null
let interim = 0

function show(s: AskState): void {
  stopListening()
  root.classList.toggle('thinking', s.state === 'thinking')
  root.classList.toggle('error', s.state === 'error')
  input.readOnly = s.state === 'thinking'
  message.textContent = s.state === 'error' ? s.message : s.state !== 'closed' ? (s.note ?? '') : ''
  if (s.state === 'idle') {
    followUp = !!s.followUp
    input.value = ''
    typing()
    if (s.listen) void listen()
  }
  if (s.state === 'idle' || s.state === 'error') input.focus()
}

/** The bar as it is when typing. */
function typing(): void {
  root.classList.remove('listening')
  input.classList.remove('heard')
  input.placeholder = followUp ? 'Ask a follow-up…' : 'Ask about your screen…'
  hint.textContent = followUp ? '↵ ask · ⌘N new · esc close' : '↵ ask · esc close'
}

async function listen(): Promise<void> {
  if (!bridge) return
  root.classList.add('listening')
  input.placeholder = followUp ? 'Listening for a follow-up…' : 'Listening…'
  hint.textContent = 'type instead · esc close'
  try {
    const m = (mic = await Mic.open({
      level: v => meter.style.setProperty('--level', v.toFixed(3)),
      speech: () => {
        interim = window.setInterval(() => void hear(m, false), INTERIM_MS)
      },
      end: why => void (why === 'nothing' ? (stopListening(), typing()) : hear(m, true)),
    }))
    if (!root.classList.contains('listening')) m.stop() // the bar moved on while the microphone opened
  } catch (e) {
    stopListening()
    typing()
    message.textContent = `Couldn't listen: ${(e as Error).message}`
  }
}

let hearing = false

/** Recognizes the question so far into the bar; at the end, asks it. */
async function hear(m: Mic, final: boolean): Promise<void> {
  if (!bridge || mic !== m || (hearing && !final)) return
  if (final) stopListening()
  hearing = true
  const text = await bridge.transcribe(m.samples()).catch(() => '')
  hearing = false
  if (final) {
    if (input.classList.contains('heard') || !input.value) input.value = text
    typing()
    if (text) bridge.submit(text)
    else message.textContent = "Didn't catch that. Try again, or type it."
  } else if (mic === m && text) {
    input.value = text
    input.classList.add('heard')
  }
}

function stopListening(): void {
  clearInterval(interim)
  mic?.stop()
  mic = null
  meter.style.setProperty('--level', '0')
}

input.addEventListener('keydown', e => {
  if (!mic || e.key === 'Escape' || e.key === 'Enter' || e.metaKey || e.ctrlKey) return
  // Typing takes over: stop listening and keep what was heard, to edit.
  stopListening()
  typing()
})

if (bridge) {
  bridge.onState(show)
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') bridge.cancel()
    else if (e.key === 'n' && e.metaKey && !input.readOnly) {
      e.preventDefault()
      bridge.startOver()
    } else if (e.key === 'Enter' && !input.readOnly) {
      if (mic?.speaking) void hear(mic, true)
      else if (input.value.trim()) bridge.submit(input.value)
    }
  })
  document.addEventListener('visibilitychange', () => document.hidden && stopListening())
} else {
  document.body.classList.add('preview')
  const states: AskState[] = [
    { state: 'idle' },
    { state: 'idle', followUp: true },
    { state: 'thinking' },
    { state: 'thinking', note: 'Searching “VS Code change editor font size”' },
    { state: 'error', message: "Claude's answer didn't fit the drawing format." },
  ]
  let i = -1
  const next = () => {
    show(states[++i % states.length])
    if (i % states.length === 0) {
      // What listening looks like, with words half heard.
      root.classList.add('listening')
      input.value = 'where do I change the font'
      input.classList.add('heard')
      meter.style.setProperty('--level', '0.5')
    } else input.value = 'where do I change the font size?'
  }
  next()
  input.addEventListener('keydown', e => e.key === 'Enter' && next())
}
