// Codex answers instead of Claude Code when the settings say so: `codex exec` on whatever account Codex is signed
// into, one run per question. Like --safe-mode for Claude Code, it runs without the user's config or rules, in a
// read-only sandbox, and ephemeral, so nothing goes into Codex's history. It doesn't stream, so the marks come all at
// once at the end, and a follow-up is a new run told what was asked and answered before. The answer is asked for as
// JSON in the drawing format and checked here; marks that don't fit are left out.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { markSchema, type MarkInput } from '../shared/marks'
import { ANSWER_JSON_SCHEMA, answerSchema, FOLLOW_UP_MS, system, TIMEOUT_MS, type Answer, type Engine, type Listener } from './answer'
import type { Capture } from './capture'
import * as settings from './settings'

const FORMAT = `Reply with one JSON object and nothing else (no words around it, no code fence) that fits this JSON Schema:
${JSON.stringify(ANSWER_JSON_SCHEMA)}`
const HISTORY_TURNS = 6 // earlier questions and answers a follow-up is told about
// Codex's reasoning efforts stop at high.
const EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }

export class Codex implements Engine {
  asked = 0
  ended = false
  waiting = false
  private child: ChildProcess | null = null
  private history: string[] = []
  private expiry: NodeJS.Timeout | null = null
  private readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-ink-codex-'))

  constructor(
    readonly key: string,
    readonly narrate: boolean,
    private onEnd: (e: Engine) => void,
  ) {}

  async ask(question: string, shot: Capture, list: string, listener: Listener): Promise<Answer> {
    this.asked++
    const image = path.join(this.dir, `screen-${this.asked}.jpg`)
    fs.writeFileSync(image, shot.jpeg)
    const text = `The screenshot is attached: ${shot.width}×${shot.height} units, x right, y down, origin top-left.${list ? `\n${list}` : ''}\nQuestion: ${question}`
    try {
      return await this.turn(text, [image], listener, `Question: ${question}`)
    } finally {
      fs.rm(image, { force: true }, () => {})
    }
  }

  tell(words: string, listener: Listener): Promise<Answer> {
    return this.turn(words, [], listener, words)
  }

  private async turn(text: string, images: string[], listener: Listener, asked: string): Promise<Answer> {
    if (this.ended) throw new Error('The conversation has ended.')
    if (this.child) throw new Error('Still answering the last question.')
    this.hold()
    this.waiting = false
    const before = this.history.length ? `Earlier in this conversation:\n${this.history.join('\n\n')}` : ''
    const prompt = [system(this.narrate, settings.get().tools), FORMAT, before, text].filter(Boolean).join('\n\n')
    try {
      let reply = await this.run(prompt, images, listener)
      let answer = parse(reply)
      if (typeof answer === 'string') {
        listener.onStep?.('Fixing the answer')
        reply = await this.run(`${prompt}\n\nYour reply couldn't be read: ${answer} Reply again, with only the JSON object.`, images, listener)
        answer = parse(reply)
        if (typeof answer === 'string') throw new Error(`Codex's answer didn't fit the drawing format: ${answer}`)
      }
      this.history = [...this.history, `${asked}\nYou answered: ${JSON.stringify(answer).slice(0, 6000)}`].slice(-HISTORY_TURNS)
      listener.onCaption?.(answer.caption)
      for (const mark of answer.marks) listener.onMark?.(mark)
      return answer
    } finally {
      if (!this.waiting) this.release(FOLLOW_UP_MS)
    }
  }

  /** Runs `codex exec` once and resolves its last message. */
  private run(prompt: string, images: string[], listener: Listener): Promise<string> {
    const { codex, codexModel, effort, tools } = settings.get()
    const args = [
      'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      ...(codexModel ? ['-m', codexModel] : []),
      ...(effort ? ['-c', `model_reasoning_effort="${EFFORT[effort]}"`] : []),
      '-c', `web_search="${/\bWebSearch\b/.test(tools) ? 'live' : 'disabled'}"`,
      ...images.flatMap(i => ['-i', i]),
      '-C', this.dir, // after the images, so it ends their list
      '-', // the prompt comes on stdin
    ]
    return new Promise((resolve, reject) => {
      const child = (this.child = spawn(codex, args, { cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }))
      let out = ''
      let err = ''
      let last = ''
      let failed = ''
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
      const read = (line: string) => {
        let e
        try {
          e = JSON.parse(line)
        } catch {
          return
        }
        const item = e.item ?? {}
        if (e.type === 'item.completed' && item.type === 'agent_message') last = item.text ?? ''
        else if (e.type === 'item.started' && item.type === 'web_search') listener.onStep?.(item.query ? `Searching “${item.query}”` : 'Searching the web')
        else if (e.type === 'item.started' && item.type === 'command_execution') listener.onStep?.('Looking around')
        else if (e.type === 'turn.failed' || e.type === 'error') failed = e.error?.message ?? e.message ?? 'Codex failed.'
      }
      child.stdout!.on('data', d => {
        const lines = (out += d).split('\n')
        out = lines.pop() ?? ''
        lines.forEach(read)
      })
      child.stderr!.on('data', d => (err = (err + d).slice(-4000)))
      child.stdin!.on('error', () => {})
      child.stdin!.end(prompt)
      child.on('error', e => {
        const code = (e as NodeJS.ErrnoException).code
        reject(code === 'ENOENT' ? new Error(`Can't find "${codex}". Set its full path in Settings.`) : e)
      })
      child.on('close', (code, signal) => {
        read(out)
        clearTimeout(timer)
        if (this.child === child) this.child = null
        if (signal) return reject(new Error(this.ended ? 'Cancelled' : 'Interrupted'))
        if (last) return resolve(last)
        reject(new Error(failed || err.trim().split('\n').pop() || `codex exited with code ${code}`))
      })
    })
  }

  hold(): void {
    if (this.expiry) clearTimeout(this.expiry)
    this.expiry = null
  }

  release(ms: number): void {
    this.hold()
    if (!this.ended && !this.child) this.expiry = setTimeout(() => this.close(), ms)
  }

  interrupt(): void {
    this.child?.kill()
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    this.hold()
    this.child?.kill()
    fs.rm(this.dir, { recursive: true, force: true }, () => {})
    this.onEnd(this)
  }
}

/** The answer in Codex's reply, keeping the marks that fit; or why there is none. */
function parse(reply: string): Answer | string {
  const text = reply.replace(/^```(?:json)?\s*|\s*```$/g, '')
  let raw: { caption?: unknown; marks?: unknown; next?: unknown; remember?: unknown }
  try {
    raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  } catch {
    return "it isn't a JSON object."
  }
  if (typeof raw.caption !== 'string') return 'it has no caption.'
  const marks = (Array.isArray(raw.marks) ? raw.marks : []).flatMap((m): MarkInput[] => {
    const ok = markSchema.safeParse(m)
    return ok.success ? [ok.data] : []
  })
  const next = answerSchema.shape.next.safeParse(raw.next ?? undefined)
  const remember = typeof raw.remember === 'string' ? raw.remember.slice(0, 200) : undefined
  return { caption: raw.caption.slice(0, 400), marks: marks.slice(0, 20), next: next.success ? next.data : undefined, remember }
}
