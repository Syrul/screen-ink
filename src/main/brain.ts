// Asks the local `claude` CLI about a screenshot, on whatever account it is signed into. --safe-mode skips the
// user's hooks, CLAUDE.md, skills and MCP servers (fast, and nothing of theirs leaks in) but keeps their login;
// --json-schema makes the answer arrive as a validated drawing. The built-in tools in TOOLS (web search by default)
// stay on and are pre-approved, since nobody is there to answer a permission prompt. With voice on, the answer is
// narrated too.
//
// One conversation is one `claude` process. It starts when the prompt bar opens, so it is ready by the time the
// question is, and waits a while after each answer: a question asked meanwhile continues the conversation ("and
// then?") with a fresh screenshot. Answers stream: each mark is handed over as soon as Claude has written it, so
// drawing starts while the rest is still being written. Cutting in interrupts the answer, not the conversation.
import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import { z } from 'zod'
import { markSchema, type MarkInput } from '../shared/marks'
import type { Capture } from './capture'
import { CLAUDE, EFFORT, INSTRUCTIONS, MODEL, NARRATE, TOOLS } from './config'
import { describe } from './sense'
import { AnswerStream } from './stream'
import * as voice from './voice'

export const answerSchema = z.object({
  caption: z.string().max(400).describe('The answer in one or two short sentences, shown at the bottom of the screen.'),
  marks: z.array(markSchema).max(20).describe('Marks that point at what the caption talks about, drawn in order. Empty when nothing on screen helps.'),
})
export type Answer = z.infer<typeof answerSchema>

// Claude Code validates --json-schema with draft-07 and rejects zod's default 2020-12 `$schema`.
const { $schema: _, ...ANSWER_JSON_SCHEMA } = z.toJSONSchema(answerSchema, { target: 'draft-7' })

const WEB = `
When the answer turns on facts the screen doesn't show and that may have changed since you were trained (versions,
prices, release notes, news, how a product works today), search the web first: one or two standard searches, then
answer from what you found. Don't search for what the screenshot already tells you.`

const FOLLOW_UPS = `
The user may ask follow-up questions. Each comes with a new screenshot of the screen as it is now and its own list of
elements: use only that turn's ids and coordinates. Build on what earlier answers said and showed, don't repeat it.`

const system = (narrate: boolean) => `${INSTRUCTIONS}
You get a screenshot of the user's screen and a question. Answer by drawing on their screen: marks in the
screenshot's coordinates, and a caption with the answer itself. Put marks on the exact thing the user needs (the
menu, button, field or line), never on a guess: if the thing isn't visible, say in the caption where to find it and
mark the nearest step that is visible (the menu that holds it, say).
When the question is how something works or how it is put together (an engine, a joint, a gearbox, a lock), answer
with one figure: build it from simple parts that sit where they really would, the moving ones with motion that shows
the mechanism, see-through housings over what's inside, and labels on the three or four parts that matter. Keep it to
what explains the idea, not every bolt.${/\bWebSearch\b/.test(TOOLS) ? WEB : ''}${FOLLOW_UPS}${narrate ? `\n${NARRATE} The caption stays the short written version.` : ''}`

const TIMEOUT_MS = 120_000 // for one answer
const FOLLOW_UP_MS = 120_000 // how long a conversation waits for the next question
const UNUSED_MS = 60_000 // how long one started for a question that never came waits
const INTERRUPT_MS = 3000 // how long an interrupted answer may take to stop before the conversation is ended

export interface Listener {
  /** A tool is running (a web search, say): what the bar shows meanwhile. */
  onStep?: (note: string) => void
  /** The caption, as soon as it is written. */
  onCaption?: (caption: string) => void
  /** A mark, as soon as it is written. Marks arrive in order, before the whole answer does. */
  onMark?: (mark: MarkInput) => void
}

/** What the bar shows while a tool runs. */
function step(name: string, input: Record<string, unknown> = {}): string {
  if (name === 'WebSearch') return `Searching “${input.query}”`
  if (name === 'WebFetch') {
    try { return `Reading ${new URL(String(input.url)).hostname}` } catch {}
  }
  if (name === 'StructuredOutput') return 'Drawing the answer'
  return `Using ${name}`
}

interface Turn {
  listener: Listener
  resolve: (a: Answer) => void
  reject: (e: Error) => void
  /** The answer as it is written, and the index of its content block in the message being streamed. */
  stream: AnswerStream | null
  block: number | null
  timer: NodeJS.Timeout
}

class Conversation {
  readonly narrate: boolean
  /** Questions asked so far, answered or not. */
  asked = 0
  ended = false
  /** The bar is open on this conversation, waiting for a question. */
  waiting = false
  private child: ChildProcess
  private turn: Turn | null = null
  private out = ''
  private err = ''
  private expiry: NodeJS.Timeout | null = null

  constructor(narrate: boolean) {
    this.narrate = narrate
    const args = [
      '-p', '--safe-mode', '--no-session-persistence',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', MODEL, ...(EFFORT ? ['--effort', EFFORT] : []),
      '--tools', TOOLS, ...(TOOLS ? ['--allowedTools', TOOLS] : []),
      '--system-prompt', system(narrate),
      '--json-schema', JSON.stringify(ANSWER_JSON_SCHEMA),
    ]
    const child = (this.child = spawn(CLAUDE, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] }))
    child.stdout!.on('data', d => {
      const lines = (this.out += d).split('\n')
      this.out = lines.pop() ?? ''
      lines.forEach(line => this.read(line))
    })
    child.stderr!.on('data', d => (this.err = (this.err + d).slice(-4000)))
    child.stdin!.on('error', () => {}) // the CLI quit before reading (bad flag, no login): 'close' reports why
    child.on('error', e => {
      const code = (e as NodeJS.ErrnoException).code
      this.end(code === 'ENOENT' ? new Error(`Can't find "${CLAUDE}". Set SCREEN_INK_CLAUDE to its full path.`) : e)
    })
    child.on('close', code => {
      this.read(this.out)
      this.end(new Error(this.err.trim().split('\n').pop() || `claude exited with code ${code}`))
    })
  }

  ask(question: string, shot: Capture, list: string, listener: Listener): Promise<Answer> {
    if (this.ended) return Promise.reject(new Error('The conversation has ended.'))
    if (this.turn) return Promise.reject(new Error('Still answering the last question.'))
    this.hold()
    this.waiting = false
    this.asked++
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.jpeg.toString('base64') } },
          { type: 'text', text: `Screenshot: ${shot.width}×${shot.height} units, x right, y down, origin top-left.${list ? `\n${list}` : ''}\nQuestion: ${question}` },
        ],
      },
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), TIMEOUT_MS)
      this.turn = { listener, resolve, reject, stream: null, block: null, timer }
      this.child.stdin!.write(JSON.stringify(message) + '\n')
    })
  }

  /** Keeps the conversation going until release. */
  hold(): void {
    if (this.expiry) clearTimeout(this.expiry)
    this.expiry = null
  }

  /** Ends the conversation unless another question comes within `ms`. */
  release(ms: number): void {
    this.hold()
    if (!this.ended && !this.turn) this.expiry = setTimeout(() => this.close(), ms)
  }

  /** Stops the answer being written; the conversation carries on. */
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
    if (current === this) current = null
  }
}

let current: Conversation | null = null

/** Starts a conversation ahead of the question, or keeps the one going. Call it when the bar opens. */
export function warm(): void {
  if (current && current.narrate !== voice.isOn()) reset() // its system prompt says whether to narrate
  if (!current) current = new Conversation(voice.isOn())
  current.hold()
  current.waiting = true
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
export async function askClaude(question: string, shot: Capture, signal: AbortSignal, listener: Listener = {}): Promise<Answer> {
  const list = describe(await shot.elements)
  if (signal.aborted) throw new Error('Cancelled')
  warm()
  const convo = current!
  const stop = () => convo.interrupt()
  signal.addEventListener('abort', stop, { once: true })
  try {
    return await convo.ask(question, shot, list, listener)
  } finally {
    signal.removeEventListener('abort', stop)
  }
}
