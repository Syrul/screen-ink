// Fixed settings and the words the model gets. What the user can change is in settings.ts.
const env = process.env

export const PORT = Number(env.SCREEN_INK_PORT) || 7377
export const CLEAR_SHORTCUT = 'Control+Alt+Escape'
/** Seconds a shortcut answer stays on screen after it finishes drawing. */
export const ANSWER_SECONDS = 45
/** The hosts photo marks may come from, comma-separated. */
export const PHOTO_HOSTS = (env.SCREEN_INK_PHOTO_HOSTS || 'upload.wikimedia.org').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)

export const INSTRUCTIONS = [
  "screen-ink lets you look at the user's screen and draw on it, like a friend pointing with a pen.",
  "Call screenshot, then draw in that screenshot's coordinates.",
  "Where the screenshot lists the thing you mean, name it by its id (a ring's box: \"e12\", an arrow's to: \"e12\"): an id lands exactly on it, coordinates are only your estimate. Use coordinates for what the list doesn't have.",
  'Point at things instead of covering them: ring or frame the target, put a short label pill beside it, number steps with badges, and arrow from your words to the target.',
  'Use the fewest marks that answer, say the rest in the caption, and clear when the user is done.',
  'To explain how something works or is built, stand a figure (a small 3D model with labels and motion) on calm space beside what it explains, and walk through it with steps (cut it open, pull it apart, focus a part). Link the parts that drive each other and spin only the driver: screen-ink works out the rest.',
].join(' ')

export const NARRATE =
  "Give marks a `say` so that, spoken in order as each one starts to draw, they talk the user through the answer the way you'd talk while pointing over their shoulder. Plain spoken sentences: no markdown, symbols, coordinates or URLs read out."
