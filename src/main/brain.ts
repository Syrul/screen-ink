// Asks a model about a screenshot. By default that's the local `claude` CLI on whatever account it is signed into:
// --safe-mode skips the user's hooks, CLAUDE.md, skills and MCP servers (fast, and nothing of theirs leaks in) but
// keeps their login. With an API key it runs with --bare instead, which reads no login at all and bills the key.
// --json-schema makes the answer arrive as a validated drawing. The built-in tools in the settings (web search by
// default) stay on and are pre-approved, since nobody is there to answer a permission prompt. With voice on, the
// answer is narrated too. Codex can answer instead (codex.ts).
//
// One conversation is one `claude` process. It starts when the prompt bar opens, so it is ready by the time the
// question is, and waits a while after each answer: a question asked meanwhile continues the conversation ("and
// then?") with a fresh screenshot. Answers stream: each mark is handed over as soon as Claude has written it, so
// drawing starts while the rest is still being written. Cutting in interrupts the answer, not the conversation.
import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import { checkFigure, checkMarks } from '../shared/check'
import { markSchema } from '../shared/marks'
import {
  ANSWER_JSON_SCHEMA, answerSchema, FOLLOW_UP_MS, INTERRUPT_MS, step, system, TIMEOUT_MS, UNUSED_MS,
  type Answer, type Engine, type Listener,
} from './answer'
import type { Capture } from './capture'
import { Codex } from './codex'
import { describe } from './sense'
import * as settings from './settings'
import { AnswerStream } from './stream'
import * as voice from './voice'

export type { Answer, Listener } from './answer'

interface Turn {
  listener: Listener
  resolve: (a: Answer) => void
  reject: (e: Error) => void
  /** The answer as it is written, and the index of its content block in the message being streamed. */
  stream: AnswerStream | null
  block: number | null
  timer: NodeJS.Timeout
}

class Claude implements Engine {
  asked = 0
  ended = false
  waiting = false
  private child: ChildProcess
  private turn: Turn | null = null
  private out = ''
  private err = ''
  private expiry: NodeJS.Timeout | null = null

  /** `apiKey` answers on an API key (with --bare) instead of the CLI's login. */
  constructor(
    readonly key: string,
    readonly narrate: boolean,
    apiKey: string | null,
    private onEnd: (e: Engine) => void,
  ) {
    const { claude, model, effort, tools } = settings.get()
    const args = [
      '-p', apiKey ? '--bare' : '--safe-mode', '--no-session-persistence',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', model, ...(effort ? ['--effort', effort] : []),
      '--tools', tools, ...(tools ? ['--allowedTools', tools] : []),
      '--system-prompt', system(narrate, tools),
      '--json-schema', JSON.stringify(ANSWER_JSON_SCHEMA),
    ]
    const env = apiKey ? { ...process.env, ANTHROPIC_API_KEY: apiKey } : process.env
    const child = (this.child = spawn(claude, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }))
    child.stdout!.on('data', d => {
      const lines = (this.out += d).split('\n')
      this.out = lines.pop() ?? ''
      lines.forEach(line => this.read(line))
    })
    child.stderr!.on('data', d => (this.err = (this.err + d).slice(-4000)))
    child.stdin!.on('error', () => {}) // the CLI quit before reading (bad flag, no login): 'close' reports why
    child.on('error', e => {
      const code = (e as NodeJS.ErrnoException).code
      this.end(code === 'ENOENT' ? new Error(`Can't find "${claude}". Set its full path in Settings.`) : e)
    })
    child.on('close', code => {
      this.read(this.out)
      this.end(new Error(this.err.trim().split('\n').pop() || `claude exited with code ${code}`))
    })
  }

  ask(question: string, shot: Capture, list: string, listener: Listener): Promise<Answer> {
    this.asked++
    return this.send(
      [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.jpeg.toString('base64') } },
        { type: 'text', text: `Screenshot: ${shot.width}×${shot.height} units, x right, y down, origin top-left.${list ? `\n${list}` : ''}\nQuestion: ${question}` },
      ],
      listener,
    )
  }

  tell(words: string, listener: Listener): Promise<Answer> {
    return this.send([{ type: 'text', text: words }], listener)
  }

  private send(content: unknown[], listener: Listener): Promise<Answer> {
    if (this.ended) return Promise.reject(new Error('The conversation has ended.'))
    if (this.turn) return Promise.reject(new Error('Still answering the last question.'))
    this.hold()
    this.waiting = false
    const message = { type: 'user', message: { role: 'user', content } }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), TIMEOUT_MS)
      this.turn = { listener, resolve, reject, stream: null, block: null, timer }
      this.child.stdin!.write(JSON.stringify(message) + '\n')
    })
  }

  hold(): void {
    if (this.expiry) clearTimeout(this.expiry)
    this.expiry = null
  }

  release(ms: number): void {
    this.hold()
    if (!this.ended && !this.turn) this.expiry = setTimeout(() => this.close(), ms)
  }

  interrupt(): void {
    const turn = this.turn
    if (!turn) return
    this.child.stdin!.write(JSON.stringify({ type: 'control_request', request_id: `stop-${Date.now()}`, request: { subtype: 'interrupt' } }) + '\n')
    setTimeout(() => this.turn === turn && this.close(), INTERRUPT_MS)
  }

  close(): void {
    this.child.stdin!.end()
    this.child.kill()
    this.end(new Error('Cancelled'))
  }

  private read(line: string): void {
    let m
    try { m = JSON.parse(line) } catch { return }
    const turn = this.turn
    if (!turn) return
    if (m.type === 'stream_event') {
      const e = m.event
      if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use' && e.content_block.name === 'StructuredOutput') {
        turn.block = e.index
        turn.stream = new AnswerStream()
      } else if (e?.type === 'content_block_delta' && e.index === turn.block && e.delta?.type === 'input_json_delta' && turn.stream) {
        const found = turn.stream.push(e.delta.partial_json ?? '')
        if (found.caption !== undefined) turn.listener.onCaption?.(found.caption)
        for (const raw of found.marks) {
          const mark = markSchema.safeParse(raw)
          if (mark.success) turn.listener.onMark?.(mark.data)
        }
      } else if (e?.type === 'content_block_stop' && e.index === turn.block) {
        turn.block = null // a later message's blocks count from 0 again
      }
    } else if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) if (b.type === 'tool_use') turn.listener.onStep?.(step(b.name, b.input))
    } else if (m.type === 'result') {
      this.turn = null
      clearTimeout(turn.timer)
      if (!this.waiting) this.release(FOLLOW_UP_MS)
      if (m.is_error) return turn.reject(new Error(m.subtype === 'error_during_execution' ? 'Interrupted' : String(m.result || m.subtype)))
      const parsed = answerSchema.safeParse(m.structured_output)
      if (!parsed.success) return turn.reject(new Error("Claude's answer didn't fit the drawing format."))
      turn.resolve(parsed.data)
    }
  }

  private end(e: Error): void {
    if (this.ended) return
    this.ended = true
    this.hold()
    const turn = this.turn
    this.turn = null
    if (turn) {
      clearTimeout(turn.timer)
      turn.reject(e)
    }
    this.onEnd(this)
  }
}

let current: Engine | null = null

/** The conversation to ask in: the one going, unless the settings it started with have changed since. */
function start(): Engine {
  const s = settings.get()
  const narrate = voice.isOn() // the system prompt says whether to narrate
  const key = [s.provider, s.model, s.effort, s.tools, s.claude, s.codex, s.codexModel, narrate].join('|')
  if (current && current.key !== key) reset()
  if (current) return current
  const onEnd = (e: Engine) => current === e && (current = null)
  if (s.provider === 'codex') return (current = new Codex(key, narrate, onEnd))
  const apiKey = s.provider === 'api-key' ? settings.apiKey() : null
  if (s.provider === 'api-key' && !apiKey) throw new Error('Add your Anthropic API key in Settings, or answer with Claude Code.')
  return (current = new Claude(key, narrate, apiKey, onEnd))
}

/** Starts a conversation ahead of the question, or keeps the one going. Call it when the bar opens. */
export function warm(): void {
  try {
    const convo = start()
    convo.hold()
    convo.waiting = true
  } catch {} // asking will say why
}

/** The bar closed without a question. */
export function idle(): void {
  if (!current) return
  current.waiting = false
  current.release(current.asked ? FOLLOW_UP_MS : UNUSED_MS)
}

/** Whether the next question continues an earlier one. */
export function followingUp(): boolean {
  return !!current && current.asked > 0
}

/** Ends the conversation: the next question starts a new one. */
export function reset(): void {
  current?.close()
  current = null
}

/** Asks about `shot`, continuing the conversation if there is one. Aborting interrupts the answer. */
export async function ask(question: string, shot: Capture, signal: AbortSignal, listener: Listener = {}): Promise<Answer> {
  const list = describe(await shot.elements)
  if (signal.aborted) throw new Error('Cancelled')
  const convo = start()
  convo.hold()
  const stop = () => convo.interrupt()
  signal.addEventListener('abort', stop, { once: true })
  try {
    if (!settings.checking()) return await convo.ask(question, shot, list, listener)
    // A figure whose mechanism can't work is held back, with whatever follows it, and Claude is asked once to fix it.
    let held = false
    let passed = 0
    const first = await convo.ask(question, shot, list, {
      ...listener,
      onMark: mark => {
        if (!held && mark.kind === 'figure' && checkFigure(mark).length) held = true
        if (held) return listener.onStep?.('Checking the figure')
        passed++
        listener.onMark?.(mark)
      },
    })
    const problems = checkMarks(first.marks)
    if (!problems.length || signal.aborted) return first
    const bad = first.marks.findIndex(m => m.kind === 'figure' && checkFigure(m).length)
    const kept = first.marks.slice(0, bad)
    for (const mark of kept.slice(passed)) listener.onMark?.(mark)
    listener.onStep?.('Fixing the figure')
    const fixed = await convo.tell(
      `Checking your figure found: ${problems.join(' ')} Answer again with the caption and the marks from that figure on, fixed.`,
      listener,
    )
    return { caption: fixed.caption || first.caption, marks: [...kept, ...fixed.marks], next: fixed.next ?? first.next }
  } finally {
    signal.removeEventListener('abort', stop)
  }
}
