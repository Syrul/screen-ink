// The prompt bar. Enter asks, Esc closes. Opened in a plain browser (no `window.askBridge`) it cycles its states.
import type { AskState } from '../main/ask'

declare global {
  interface Window {
    askBridge?: { submit(q: string): void; cancel(): void; onState(cb: (s: AskState) => void): void }
  }
}

const root = document.getElementById('root') as HTMLElement
const input = document.getElementById('question') as HTMLInputElement
const message = document.getElementById('message') as HTMLDivElement

function show(s: AskState): void {
  root.classList.toggle('thinking', s.state === 'thinking')
  root.classList.toggle('error', s.state === 'error')
  input.readOnly = s.state === 'thinking'
  message.textContent = s.state === 'error' ? s.message : s.state === 'thinking' ? (s.note ?? '') : ''
  if (s.state === 'idle') input.value = ''
  if (s.state !== 'thinking') input.focus()
}

const bridge = window.askBridge
if (bridge) {
  bridge.onState(show)
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') bridge.cancel()
    else if (e.key === 'Enter' && !input.readOnly && input.value.trim()) bridge.submit(input.value)
  })
} else {
  document.body.classList.add('preview')
  input.value = 'where do I change the font size?'
  const states: AskState[] = [
    { state: 'idle' },
    { state: 'thinking' },
    { state: 'thinking', note: 'Searching “VS Code change editor font size”' },
    { state: 'error', message: "Claude's answer didn't fit the drawing format." },
  ]
  let i = 0
  input.addEventListener('keydown', e => e.key === 'Enter' && show(states[++i % states.length]))
}
