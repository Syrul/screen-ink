// A sample drawing on a 1280×800 canvas. The browser preview draws it over a mock window laid out to match,
// and the tray's "Draw demo" draws it over whatever is on screen.
import type { Mark } from './marks'

export const DEMO_SIZE = { width: 1280, height: 800 }

export const DEMO_CAPTION = 'Click Share in the top-right, then pick who gets access.'

export const DEMO_MARKS: Mark[] = [
  { kind: 'frame', box: [146, 188, 218, 508], text: 'Your files' },
  { kind: 'underline', box: [420, 296, 352, 28] },
  { kind: 'highlight', box: [418, 341, 220, 26] },
  { kind: 'ring', box: [980, 118, 112, 36] },
  { kind: 'badge', at: [972, 110], n: 1 },
  { kind: 'label', box: [980, 118, 112, 36], text: 'Click Share', side: 'left' },
  { kind: 'text', at: [880, 420], text: 'then pick who\nto share with' },
  { kind: 'arrow', from: [960, 410], to: [1032, 170], bend: -0.3 },
  { kind: 'badge', at: [860, 432], n: 2 },
]
