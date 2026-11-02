// The build panel: the step of the instructions the user is building from, on the side of the screen: the page's
// picture (only the step's part, when a page holds two), what the step asks, and Back and Next. It stays through
// drawings and clears. Its buttons go to the main process, which sends the step to show next; each step's words are
// read out once. Folded, it is only its title bar, out of the way. When the set has a 3D model that lines up with the
// instructions, the step shows in 3D (model.ts), and the page is a click away.
import type { BuildMove, BuildPanel } from '../shared/build'
import * as model3d from './model'

const VIEW_HEIGHT = 0.62 // the most of the screen's height the picture takes
const VIEW_3D = 0.8 // the 3D view's height, for its width

const panel = document.createElement('div')
panel.id = 'build'
panel.className = 'interactive'
panel.innerHTML = `
  <div class="build-head">
    <span class="build-title"></span>
    <span class="build-label"></span>
    <button class="build-icon build-go" data-go="back" title="Back">‹</button>
    <button class="build-icon build-go" data-go="next" title="Next">›</button>
    <button class="build-icon build-fold" title="Fold the panel away">–</button>
    <button class="build-icon" data-go="close" title="Close the instructions (they keep your place)">✕</button>
  </div>
  <div class="build-bar"><i></i></div>
  <div class="build-status"></div>
  <div class="build-view">
    <img alt="" />
    <div class="build-modes"><button data-go="3d">3D</button><button data-go="page">Page</button></div>
    <div class="build-note"></div>
  </div>
  <div class="build-say"></div>
  <div class="build-meta"></div>
  <div class="build-nav">
    <button class="build-back" data-go="back">Back</button>
    <button class="build-next" data-go="next">Next</button>
  </div>`
document.getElementById('cards')!.before(panel)

const $ = <T extends HTMLElement>(s: string) => panel.querySelector(s) as T
const title = $('.build-title')
const label = $('.build-label')
const bar = $('.build-bar > i')
const status = $('.build-status')
const view = $('.build-view')
const img = $<HTMLImageElement>('.build-view img')
const note = $('.build-note')
const say = $('.build-say')
const meta = $('.build-meta')

let shown: BuildPanel | null = null
let spoken = ''
let go: (move: BuildMove) => void = () => {}
let speak: (text: string) => void = () => {}

/** Where the panel's buttons and words go, and where its 3D models' parts come from. */
export function connect(hooks: { go: (move: BuildMove) => void; speak: (text: string) => void; parts?: Parameters<typeof model3d.connect>[0] }): void {
  go = hooks.go
  speak = hooks.speak
  if (hooks.parts) model3d.connect(hooks.parts)
}

panel.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('button')
  if (!b || b.disabled) return
  if (b.classList.contains('build-fold')) {
    const small = panel.classList.toggle('small')
    b.textContent = small ? '+' : '–'
    b.title = small ? 'Show the step' : 'Fold the panel away'
    return
  }
  if (b.dataset.go) go(b.dataset.go as BuildMove)
})

/** Shows `p`, or puts the panel away (null). */
export function show(p: BuildPanel | null): void {
  shown = p
  if (!p) {
    panel.classList.remove('show')
    spoken = ''
    return
  }
  panel.style.setProperty('--build', p.ink ?? '#FF5A36')
  panel.classList.add('show')
  title.textContent = p.title
  label.textContent = p.label
  bar.style.width = `${((p.index + 1) / Math.max(1, p.total)) * 100}%`
  panel.classList.toggle('waiting', !!p.status && !p.image)
  status.textContent = p.status ?? ''
  say.textContent = p.say ?? ''
  meta.textContent = [p.parts ? `${p.parts} part${p.parts === 1 ? '' : 's'}` : '', p.times ? `Build it ${p.times}×` : ''].filter(Boolean).join(' · ')
  for (const b of panel.querySelectorAll<HTMLButtonElement>('[data-go="back"]')) b.disabled = p.index <= 0
  for (const b of panel.querySelectorAll<HTMLButtonElement>('[data-go="next"]')) b.disabled = p.index >= p.total - 1
  const in3d = !!p.model && p.in3d !== false
  panel.classList.toggle('has3d', !!p.model)
  panel.classList.toggle('in3d', in3d)
  for (const b of panel.querySelectorAll<HTMLButtonElement>('.build-modes button')) b.classList.toggle('on', (b.dataset.go === '3d') === in3d)
  note.textContent = in3d ? p.model!.credit : (p.modelStatus ?? '')
  if (in3d) {
    if (!view.querySelector('canvas')) view.prepend(model3d.canvas())
    const m = p.model!
    void model3d.draw(m, p.ink ?? '#FF5A36').then(ok => {
      if (!ok && shown?.model === m) (panel.classList.remove('in3d'), (note.textContent = "Couldn't draw the 3D model."), layout())
    })
  }
  if (p.image && img.src !== p.image) {
    img.style.visibility = 'hidden'
    img.src = p.image
  }
  layout()
  // Each step's words once, and again when better ones come (Claude has read the page).
  const key = `${p.title}|${p.index}|${p.say ?? ''}`
  if (p.say && !p.status && key !== spoken) {
    spoken = key
    speak(p.say)
  }
}

/** Sizes the picture to fit, showing only the step's part of the page; or the 3D view. */
function layout(): void {
  if (panel.classList.contains('in3d')) {
    const [w, h] = [panel.clientWidth, Math.min(panel.clientWidth * VIEW_3D, innerHeight * VIEW_HEIGHT)]
    Object.assign(view.style, { width: `${w}px`, height: `${h}px` })
    return model3d.resize(w, h)
  }
  if (!shown?.image || !img.naturalWidth) return
  const [cx, cy, cw, ch] = shown.crop ?? [0, 0, 1, 1]
  const [W, H] = [img.naturalWidth, img.naturalHeight]
  const s = Math.min(panel.clientWidth / (cw * W), (innerHeight * VIEW_HEIGHT) / (ch * H))
  Object.assign(view.style, { width: `${cw * W * s}px`, height: `${ch * H * s}px` })
  Object.assign(img.style, { width: `${W * s}px`, height: `${H * s}px`, transform: `translate(${-cx * W * s}px, ${-cy * H * s}px)`, visibility: 'visible' })
}

img.addEventListener('load', layout)
addEventListener('resize', layout)
