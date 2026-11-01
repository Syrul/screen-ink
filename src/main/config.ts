// Settings, all from the environment so `npm start` needs none.
const env = process.env

export const PORT = Number(env.SCREEN_INK_PORT) || 7377
export const INK = /^#[0-9a-fA-F]{6}$/.test(env.SCREEN_INK_COLOR ?? '') ? env.SCREEN_INK_COLOR! : '#FF5A36'
export const ASK_SHORTCUT = env.SCREEN_INK_HOTKEY || 'Alt+Shift+Space'
export const CLEAR_SHORTCUT = 'Control+Alt+Escape'
/** The CLI the shortcut asks, and its model. */
export const CLAUDE = env.SCREEN_INK_CLAUDE || 'claude'
export const MODEL = env.SCREEN_INK_MODEL || 'sonnet'
/** Seconds a shortcut answer stays on screen after it finishes drawing. */
export const ANSWER_SECONDS = 45
// Claude Code's built-in tools the shortcut may use, all without asking. WebFetch is left out by default because
// it can send anything on screen to any URL; add it (or Read, Grep, …) here if you want that.
export const TOOLS = env.SCREEN_INK_TOOLS ?? 'WebSearch'
/** The narration voice: a Kokoro voice (default af_heart), `say` or `say:<macOS voice>` for macOS's own, or `off`. */
export const VOICE = env.SCREEN_INK_VOICE || 'af_heart'

export const INSTRUCTIONS = [
  "screen-ink lets you look at the user's screen and draw on it, like a friend pointing with a pen.",
  "Call screenshot, then draw in that screenshot's coordinates.",
  'Point at things instead of covering them: ring or frame the target, put a short label pill beside it, number steps with badges, and arrow from your words to the target.',
  'Use the fewest marks that answer, say the rest in the caption, and clear when the user is done.',
  'To explain how something works or is built, stand a figure (a small 3D model with labels and motion) on calm space beside what it explains.',
].join(' ')

export const NARRATE =
  "Give marks a `say` so that, spoken in order as each one starts to draw, they talk the user through the answer the way you'd talk while pointing over their shoulder. Plain spoken sentences: no markdown, symbols, coordinates or URLs read out."
