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

export const INSTRUCTIONS = [
  "screen-ink lets you look at the user's screen and draw on it, like a friend pointing with a pen.",
  "Call screenshot, then draw in that screenshot's coordinates.",
  'Point at things instead of covering them: ring or frame the target, put a short label pill beside it, number steps with badges, and arrow from your words to the target.',
  'Use the fewest marks that answer, say the rest in the caption, and clear when the user is done.',
].join(' ')
