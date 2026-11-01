// Settings, all from the environment so `npm start` needs none.
const env = process.env

export const PORT = Number(env.SCREEN_INK_PORT) || 7377
export const INK = /^#[0-9a-fA-F]{6}$/.test(env.SCREEN_INK_COLOR ?? '') ? env.SCREEN_INK_COLOR! : '#FF5A36'
export const ASK_SHORTCUT = env.SCREEN_INK_HOTKEY || 'Alt+Shift+Space'
export const CLEAR_SHORTCUT = 'Control+Alt+Escape'
/** The CLI the shortcut asks, and its model. */
export const CLAUDE = env.SCREEN_INK_CLAUDE || 'claude'
export const MODEL = env.SCREEN_INK_MODEL || 'sonnet'
/** low, medium, high, xhigh or max. Unset, the CLI's default applies: --safe-mode skips your settings' effortLevel. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const EFFORT = EFFORTS.includes(env.SCREEN_INK_EFFORT ?? '') ? env.SCREEN_INK_EFFORT! : ''
if (env.SCREEN_INK_EFFORT && !EFFORT) console.error(`screen-ink: SCREEN_INK_EFFORT must be one of ${EFFORTS.join(', ')}; using the CLI's default.`)
/** Seconds a shortcut answer stays on screen after it finishes drawing. */
export const ANSWER_SECONDS = 45
// Claude Code's built-in tools the shortcut may use, all without asking. WebFetch is left out by default because
// it can send anything on screen to any URL; add it (or Read, Grep, …) here if you want that.
export const TOOLS = env.SCREEN_INK_TOOLS ?? 'WebSearch'
/** The narration voice: a Kokoro voice (default af_heart), `say` or `say:<macOS voice>` for macOS's own, or `off`. */
export const VOICE = env.SCREEN_INK_VOICE || 'af_heart'
/** Whether to caption the narration on screen as it is spoken: `off` starts with captions off. */
export const CAPTIONS = env.SCREEN_INK_CAPTIONS !== 'off'
/** Whether the bar listens for a spoken question as it opens: `off` starts with it typing only. */
export const LISTEN = env.SCREEN_INK_LISTEN !== 'off'

export const INSTRUCTIONS = [
  "screen-ink lets you look at the user's screen and draw on it, like a friend pointing with a pen.",
  "Call screenshot, then draw in that screenshot's coordinates.",
  "Where the screenshot lists the thing you mean, name it by its id (a ring's box: \"e12\", an arrow's to: \"e12\"): an id lands exactly on it, coordinates are only your estimate. Use coordinates for what the list doesn't have.",
  'Point at things instead of covering them: ring or frame the target, put a short label pill beside it, number steps with badges, and arrow from your words to the target.',
  'Use the fewest marks that answer, say the rest in the caption, and clear when the user is done.',
  'To explain how something works or is built, stand a figure (a small 3D model with labels and motion) on calm space beside what it explains.',
].join(' ')

export const NARRATE =
  "Give marks a `say` so that, spoken in order as each one starts to draw, they talk the user through the answer the way you'd talk while pointing over their shoulder. Plain spoken sentences: no markdown, symbols, coordinates or URLs read out."
