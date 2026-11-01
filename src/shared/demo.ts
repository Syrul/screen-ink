// A sample drawing on a 1280×800 canvas. The browser preview draws it over a mock window laid out to match,
// and the tray's "Draw demo" draws it over whatever is on screen.
import type { Mark } from './marks'

export const DEMO_SIZE = { width: 1280, height: 800 }

export const DEMO_CAPTION = 'Click Share in the top-right, then pick who gets access.'

export const DEMO_MARKS: Mark[] = [
  { kind: 'frame', box: [146, 188, 218, 508], text: 'Your files', say: 'Your files are all over here in the sidebar.' },
  { kind: 'underline', box: [420, 296, 352, 28] },
  { kind: 'highlight', box: [418, 341, 220, 26] },
  { kind: 'ring', box: [980, 118, 112, 36], say: 'To share the plan, click Share, up here in the top right.' },
  { kind: 'badge', at: [972, 110], n: 1 },
  { kind: 'label', box: [980, 118, 112, 36], text: 'Click Share', side: 'left' },
  { kind: 'text', at: [880, 420], text: 'then pick who\nto share with', say: 'Then pick who gets access, and you are done.' },
  { kind: 'arrow', from: [960, 410], to: [1032, 170], bend: -0.3 },
  { kind: 'badge', at: [860, 432], n: 2 },
]

export const DEMO_FIGURE_CAPTION = 'The piston slides up and down; the rod turns that into the crank spinning, and the gears pass the spin on.'

// Gears mesh when their centres are about (r1 + r2) × 0.93 apart; speeds go in inverse ratio of teeth.
export const DEMO_FIGURE_MARKS: Mark[] = [
  {
    kind: 'figure',
    box: [640, 170, 500, 500],
    title: 'How a piston turns a crank',
    turntable: false,
    view: { yaw: 28, pitch: 16 },
    say: 'Here is how a piston turns a crank.',
    parts: [
      { id: 'cylinder', shape: 'tube', size: [0.62, 0.55, 1.5], at: [0, 1.3, 0], material: 'steel' },
      {
        id: 'head',
        shape: 'lathe',
        points: [[0.66, 0], [0.66, 0.12], [0.5, 0.24], [0.12, 0.3], [0.001, 0.3]],
        at: [0, 2.05, 0],
        material: 'steel',
      },
      { id: 'bolt', shape: 'cylinder', size: [0.045, 0.14], at: [0.58, 2.2, 0], material: 'brass', copies: { count: 6, around: 'y' } },
      { id: 'fuel line', shape: 'pipe', size: [0.035], path: [[0, 0, 0], [0.35, 0.25, 0], [0.8, 0.15, 0.2], [1.05, -0.35, 0.25]], at: [0.12, 2.32, 0], material: 'rubber' },
      { id: 'piston', shape: 'cylinder', size: [0.53, 0.45], at: [0, 1.25, 0], color: '#E7A9A3', motion: { kind: 'slide', axis: 'y', amount: 0.28, speed: 0.4 } },
      { id: 'rod', shape: 'box', size: [0.14, 1.0, 0.14], at: [0, 0.5, 0], color: '#D9D4C7', motion: { kind: 'slide', axis: 'y', amount: 0.28, speed: 0.4 } },
      { id: 'crank', shape: 'cylinder', size: [0.45, 0.18], at: [0, -0.25, 0], rot: [90, 0, 0], color: '#A9C1DD', motion: { kind: 'spin', axis: 'y', speed: 0.4 } },
      { id: 'big gear', shape: 'gear', size: [0.62, 0.16, 16], at: [0, -0.25, -0.3], rot: [90, 0, 0], material: 'brass', motion: { kind: 'spin', axis: 'y', speed: 0.4 } },
      { id: 'small gear', shape: 'gear', size: [0.42, 0.16, 11], at: [0.97, -0.25, -0.3], rot: [90, 0, 0], material: 'steel', motion: { kind: 'spin', axis: 'y', speed: -0.58, phase: 0.05 } },
    ],
    labels: [
      { text: 'Cylinder', part: 'cylinder', at: [0.62, 0.55, 0] },
      { text: 'Piston', part: 'piston' },
      { text: 'Crank', part: 'crank' },
      { text: 'Gears', part: 'small gear' },
    ],
    steps: [
      { say: 'Cut the cylinder open, and the piston is inside, sliding up and down.', cut: { axis: 'z', parts: ['cylinder', 'head'] }, view: { yaw: 18, pitch: 10 } },
      { say: 'The rod turns that push into the crank spinning round.', focus: ['piston', 'rod', 'crank'], motion: 'slow' },
      { say: 'Pulled apart, each piece is easy to see.', focus: [], explode: 0.8, motion: 'pause', cut: { axis: 'off' } },
      { say: 'Put back together, the gears pass the spin on to the next shaft.', explode: 0, motion: 'play', look: 'small gear', view: { zoom: 1.5, yaw: 40 } },
      { say: 'And that is the whole machine.', look: 'all', view: { zoom: 1, yaw: 28, pitch: 16 } },
    ],
  },
]
