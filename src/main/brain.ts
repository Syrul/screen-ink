// Asks the local `claude` CLI about a screenshot, on whatever account it is signed into. --safe-mode skips the
// user's hooks, CLAUDE.md, skills and MCP servers (fast, and nothing of theirs leaks in) but keeps their login;
// --json-schema makes the answer arrive as a validated drawing.
import { spawn } from 'node:child_process'
import os from 'node:os'
import { z } from 'zod'
import { markSchema } from '../shared/marks'
import type { Capture } from './capture'
import { CLAUDE, INSTRUCTIONS, MODEL } from './config'

export const answerSchema = z.object({
  caption: z.string().max(400).describe('The answer in one or two short sentences, shown at the bottom of the screen.'),
  marks: z.array(markSchema).max(20).describe('Marks that point at what the caption talks about, drawn in order. Empty when nothing on screen helps.'),
})
export type Answer = z.infer<typeof answerSchema>

// Claude Code validates --json-schema with draft-07 and rejects zod's default 2020-12 `$schema`.
const { $schema: _, ...ANSWER_JSON_SCHEMA } = z.toJSONSchema(answerSchema, { target: 'draft-7' })

const SYSTEM = `${INSTRUCTIONS}
You get one screenshot of the user's screen and one question. Answer by drawing on their screen: marks in the
screenshot's coordinates, and a caption with the answer itself. Put marks on the exact thing the user needs (the
menu, button, field or line), never on a guess: if the thing isn't visible, say in the caption where to find it and
mark the nearest step that is visible (the menu that holds it, say).
When the question is how something works or how it is put together (an engine, a joint, a gearbox, a lock), answer
with one figure: build it from simple parts that sit where they really would, the moving ones with motion that shows
the mechanism, see-through housings over what's inside, and labels on the three or four parts that matter. Keep it to
what explains the idea, not every bolt.`

const TIMEOUT_MS = 90_000

export function askClaude(question: string, shot: Capture, signal: AbortSignal): Promise<Answer> {
  const args = [
    '-p', '--safe-mode', '--no-session-persistence',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', MODEL, '--tools', '',
    '--system-prompt', SYSTEM,
    '--json-schema', JSON.stringify(ANSWER_JSON_SCHEMA),
  ]
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.jpeg.toString('base64') } },
        { type: 'text', text: `Screenshot: ${shot.width}×${shot.height} units, x right, y down, origin top-left.\nQuestion: ${question}` },
      ],
    },
  }

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], signal })
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
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
      const result = out
        .split('\n')
        .map(line => { try { return JSON.parse(line) } catch { return null } })
        .find(m => m?.type === 'result')
      if (!result) return reject(new Error(err.trim().split('\n').pop() || `claude exited with code ${code}`))
      if (result.is_error) return reject(new Error(String(result.result || result.subtype)))
      const parsed = answerSchema.safeParse(result.structured_output)
      if (!parsed.success) return reject(new Error("Claude's answer didn't fit the drawing format."))
      resolve(parsed.data)
    })
    child.stdin.end(JSON.stringify(message) + '\n')
  })
}
