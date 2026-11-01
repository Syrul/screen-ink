// Asks the local `claude` CLI about a screenshot, on whatever account it is signed into. --safe-mode skips the
// user's hooks, CLAUDE.md, skills and MCP servers (fast, and nothing of theirs leaks in) but keeps their login;
// --json-schema makes the answer arrive as a validated drawing. The built-in tools in TOOLS (web search by default)
// stay on and are pre-approved, since nobody is there to answer a permission prompt. With voice on, the answer is
// narrated too.
import { spawn } from 'node:child_process'
import os from 'node:os'
import { z } from 'zod'
import { markSchema } from '../shared/marks'
import type { Capture } from './capture'
import { CLAUDE, EFFORT, INSTRUCTIONS, MODEL, NARRATE, TOOLS } from './config'
import { describe } from './sense'
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

const system = (narrate: boolean) => `${INSTRUCTIONS}
You get one screenshot of the user's screen and one question. Answer by drawing on their screen: marks in the
screenshot's coordinates, and a caption with the answer itself. Put marks on the exact thing the user needs (the
menu, button, field or line), never on a guess: if the thing isn't visible, say in the caption where to find it and
mark the nearest step that is visible (the menu that holds it, say).
When the question is how something works or how it is put together (an engine, a joint, a gearbox, a lock), answer
with one figure: build it from simple parts that sit where they really would, the moving ones with motion that shows
the mechanism, see-through housings over what's inside, and labels on the three or four parts that matter. Keep it to
what explains the idea, not every bolt.${/\bWebSearch\b/.test(TOOLS) ? WEB : ''}${narrate ? `\n${NARRATE} The caption stays the short written version.` : ''}`

const TIMEOUT_MS = 120_000

/** What the bar shows while a tool runs. */
function step(name: string, input: Record<string, unknown> = {}): string {
  if (name === 'WebSearch') return `Searching “${input.query}”`
  if (name === 'WebFetch') {
    try { return `Reading ${new URL(String(input.url)).hostname}` } catch {}
  }
  if (name === 'StructuredOutput') return 'Drawing the answer'
  return `Using ${name}`
}

export async function askClaude(question: string, shot: Capture, signal: AbortSignal, onStep: (note: string) => void = () => {}): Promise<Answer> {
  const list = describe(await shot.elements)
  const args = [
    '-p', '--safe-mode', '--no-session-persistence',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', MODEL, ...(EFFORT ? ['--effort', EFFORT] : []),
    '--tools', TOOLS, ...(TOOLS ? ['--allowedTools', TOOLS] : []),
    '--system-prompt', system(voice.isOn()),
    '--json-schema', JSON.stringify(ANSWER_JSON_SCHEMA),
  ]
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
    const child = spawn(CLAUDE, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], signal })
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    let out = ''
    let err = ''
    let result: any = null
    const read = (line: string) => {
      let m
      try { m = JSON.parse(line) } catch { return }
      if (m?.type === 'result') result = m
      else if (m?.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'tool_use') onStep(step(b.name, b.input))
    }
    child.stdout.on('data', d => {
      const lines = (out += d).split('\n')
      out = lines.pop() ?? ''
      lines.forEach(read)
    })
    child.stderr.on('data', d => (err += d))
    child.stdin.on('error', () => {}) // the CLI quit before reading (bad flag, no login): 'close' reports why
    child.on('error', e => {
      clearTimeout(timer)
      const code = (e as NodeJS.ErrnoException).code
      reject(code === 'ENOENT' ? new Error(`Can't find "${CLAUDE}". Set SCREEN_INK_CLAUDE to its full path.`) : e)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (signal.aborted) return
      read(out)
      if (!result) return reject(new Error(err.trim().split('\n').pop() || `claude exited with code ${code}`))
      if (result.is_error) return reject(new Error(String(result.result || result.subtype)))
      const parsed = answerSchema.safeParse(result.structured_output)
      if (!parsed.success) return reject(new Error("Claude's answer didn't fit the drawing format."))
      resolve(parsed.data)
    })
    child.stdin.end(JSON.stringify(message) + '\n')
  })
}
