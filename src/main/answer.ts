// What an answer is, what the model is told, and what any engine that answers (Claude Code or Codex) offers.
import { z } from 'zod'
import { markSchema, target, type MarkInput } from '../shared/marks'
import type { Capture } from './capture'
import { INSTRUCTIONS, NARRATE } from './config'
import * as memory from './memory'

export const scrollSchema = z.object({
  direction: z.enum(['down', 'up', 'right', 'left']),
  by: z.number().min(20).max(5000).optional().describe('How far the content moves, in screenshot units. Default: most of the screen.'),
  at: target.optional().describe('What to scroll (the page, list or panel), as a box or element id. Default: the middle of the screen.'),
})
export type Scroll = z.infer<typeof scrollSchema>

export const answerSchema = z.object({
  caption: z.string().max(400).describe('The answer in one or two short sentences, shown at the bottom of the screen.'),
  marks: z.array(markSchema).max(20).describe('Marks that point at what the caption talks about, drawn in order. Empty when nothing on screen helps.'),
  next: target
    .optional()
    .describe(
      'In a walkthrough, what the user clicks to finish the step you are showing. screen-ink waits for that click, then shows you ' +
        'the screen again for the next step. Leave it out on the last step, and when the answer is not a walkthrough.',
    ),
  scroll: scrollSchema
    .optional()
    .describe(
      'In a walkthrough, when what the user needs is out of view (further down a web page, in a long list): scroll there ' +
        'instead of giving next. screen-ink waits for the user to scroll, or scrolls for them, then shows you the screen again.',
    ),
  final: z
    .boolean()
    .optional()
    .describe(
      'In a walkthrough, true when clicking next sends, buys, pays, deletes, signs in or out, installs, grants access, or ' +
        "otherwise can't be undone or reaches beyond this Mac. screen-ink never clicks such a step for the user.",
    ),
  remember: z
    .string()
    .max(200)
    .optional()
    .describe(
      'A short fact about the user worth knowing next time (the tools they use, how experienced they are, what they prefer), ' +
        'if this question showed a new one. Only what they would be glad you remembered: never passwords, keys, money, health or ' +
        "other people's details, and nothing just read off the screen.",
    ),
})
export type Answer = z.infer<typeof answerSchema>

// Claude Code validates --json-schema with draft-07 and rejects zod's default 2020-12 `$schema`.
export const { $schema: _, ...ANSWER_JSON_SCHEMA } = z.toJSONSchema(answerSchema, { target: 'draft-7' })

const WEB = `
When the answer turns on facts the screen doesn't show and that may have changed since you were trained (versions,
prices, release notes, news, how a product works today), search the web first: one or two standard searches, then
answer from what you found. Don't search for what the screenshot already tells you.`

const MARKS = `
Pick the mark that fits what you are saying: check and cross to judge options on screen, strike for what is wrong or
out of date, connect to tie two things together; a note for a few sentences beside the thing they explain; a steps
card for a short list of things to do; a code card for a command or snippet to copy (highlight the line that matters);
math for a formula; a plot, timeline or flow for numbers over time, a sequence of events, or how steps lead to each
other; a photo from Wikimedia Commons, with its source, when seeing the real thing helps; and an action button when the
user will want to copy a command, open a page or settings pane, or type something into the field in front. When they
ask for work done in a project (fix this error, write the script, refactor this), offer an agent button that hands it
to Claude Code: the task said in full, and the project's folder when the screen shows it. Buttons only do what they
say, when clicked.`

const WALKTHROUGH = `
When the task takes several clicks (changing a setting, finding a menu), walk the user through it: show only the first
step, the one thing to click, and set next to it. Once they click it you get the screen as it is then: show the next
step the same way, and leave next out when the task is done. Say in the caption what the step does, briefly.
When what they need is out of view (further down a web page or a long list), make the step a scroll instead: set
scroll (which way, about how far, and what to scroll), leave out next, draw an arrow the way it goes, and say what is
down there. You get the screen again once it has scrolled.
The user may let screen-ink click the steps for them: then you're told it pressed the step, and the steps go by
without waiting, so keep each one short. Set final on a step whose click can't be taken back (it sends, buys,
deletes, signs in, installs or grants access): screen-ink leaves that click to the user.`

const FOLLOW_UPS = `
The user may ask follow-up questions. Each comes with a new screenshot of the screen as it is now and its own list of
elements: use only that turn's ids and coordinates. Build on what earlier answers said and showed, don't repeat it.`

export const system = (narrate: boolean, tools: string) => `${INSTRUCTIONS}
You get a screenshot of the user's screen and a question. Answer by drawing on their screen: marks in the
screenshot's coordinates, and a caption with the answer itself. Put marks on the exact thing the user needs (the
menu, button, field or line), never on a guess: if the thing isn't visible, say in the caption where to find it and
mark the nearest step that is visible (the menu that holds it, say).
When the question is how something works or how it is put together (an engine, a joint, a gearbox, a lock), answer
with one figure: build it from simple parts that sit where they really would, the moving ones with motion that shows
the mechanism, see-through housings over what's inside, and labels on the three or four parts that matter. Keep it to
what explains the idea, not every bolt. Join parts that drive each other with links (meshing gears, a belt, a shared
shaft, a crank driving a rod and piston, a spring held by a moving part) and give only the driving part a spin:
screen-ink works out the speeds, spacing and timing, so it moves as the real one does. A pipe can flow to show what
runs through it, and pendulums and bounces keep gravity's time. Turned parts (a valve, a bottle) are lathes, flat cut parts (a cam, a bracket)
are extrudes, bent ones (a hose) are pipes, and a set of like parts is one part with copies; give parts real materials
where it helps them read (steel, brass, glass). Then walk through it in two to four steps, each saying one thing while
the figure shows it: cut the housing open, pull the parts apart, focus on the part being talked about, slow the motion
or move in close. The figure's own say is a short opening; the steps carry the explanation.${MARKS}${WALKTHROUGH}${/\bWebSearch\b/.test(tools) ? WEB : ''}${FOLLOW_UPS}${narrate ? `\n${NARRATE} The caption stays the short written version.` : ''}${memory.brief() ? `\n${memory.brief()}` : ''}`

export const TIMEOUT_MS = 120_000 // for one answer
export const FOLLOW_UP_MS = 120_000 // how long a conversation waits for the next question
export const UNUSED_MS = 60_000 // how long one started for a question that never came waits
export const INTERRUPT_MS = 3000 // how long an interrupted answer may take to stop before the conversation is ended

export interface Listener {
  /** A tool is running (a web search, say): what the bar shows meanwhile. */
  onStep?: (note: string) => void
  /** The caption, as soon as it is written. */
  onCaption?: (caption: string) => void
  /** A mark, as soon as it is written. Marks arrive in order, before the whole answer does. */
  onMark?: (mark: MarkInput) => void
}

/** What the bar shows while a tool runs. */
export function step(name: string, input: Record<string, unknown> = {}): string {
  if (name === 'WebSearch') return `Searching “${input.query}”`
  if (name === 'WebFetch') {
    try { return `Reading ${new URL(String(input.url)).hostname}` } catch {}
  }
  if (name === 'StructuredOutput') return 'Drawing the answer'
  return `Using ${name}`
}

/** One conversation with a model: questions about screenshots, answered as drawings. */
export interface Engine {
  /** The settings it was started with: a conversation is started afresh when they change. */
  readonly key: string
  readonly narrate: boolean
  /** Questions asked so far, answered or not. */
  asked: number
  ended: boolean
  /** The bar is open on this conversation, waiting for a question. */
  waiting: boolean
  ask(question: string, shot: Capture, list: string, listener: Listener): Promise<Answer>
  /** Sends words alone, about the last answer. */
  tell(words: string, listener: Listener): Promise<Answer>
  /** Keeps the conversation going until release. */
  hold(): void
  /** Ends the conversation unless another question comes within `ms`. */
  release(ms: number): void
  /** Stops the answer being written; the conversation carries on. */
  interrupt(): void
  close(): void
}
