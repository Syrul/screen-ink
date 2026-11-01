// 3D figures: a small three.js model on a card, drawn like an illustration (toon shading, ink outline and
// creases). Parts grow in one by one as beats, labels pop in and follow their parts, then motion starts.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { FigureMark } from '../shared/marks'
import { clamp, easeBack, el, now, textWidth, UI_FONT, type Beat } from './common'
import type { Rect } from './shapes'

type Part = FigureMark['parts'][number]
type Motion = NonNullable<Part['motion']>

const PALETTE = ['#A9C1DD', '#F2C48D', '#B9DDB5', '#E7A9A3', '#CDBFEA', '#D9D4C7']
const INK = '#30333A'
const TITLE_SPACE = 40
const PILL_H = 22
const PILL_FONT = `600 12px ${UI_FONT}`
const TURNTABLE = 0.25 // radians per second
const MIN_CARD = { w: 380, h: 300 } // points: room for the model and its label pills

const live = new Set<{ dispose(): void }>()

export function disposeFigures(): void {
  for (const f of live) f.dispose()
  live.clear()
}

// Three bands of light: flat, illustrated shading.
const toonBands = (() => {
  const t = new THREE.DataTexture(new Uint8Array([110, 190, 255]), 3, 1, THREE.RedFormat)
  t.minFilter = t.magFilter = THREE.NearestFilter
  t.needsUpdate = true
  return t
})()

// ---- shapes (round ones stand along y)

class Helix extends THREE.Curve<THREE.Vector3> {
  radius: number
  length: number
  coils: number
  constructor(radius: number, length: number, coils: number) {
    super()
    this.radius = radius
    this.length = length
    this.coils = coils
  }
  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const a = t * this.coils * Math.PI * 2
    return target.set(Math.cos(a) * this.radius, (t - 0.5) * this.length, Math.sin(a) * this.radius)
  }
}

function gear(radius: number, thickness: number, teeth: number): THREE.BufferGeometry {
  const n = clamp(Math.round(teeth), 6, 60)
  const root = radius * 0.86
  const step = (Math.PI * 2) / n
  const shape = new THREE.Shape()
  for (let i = 0; i < n; i++) {
    const a = i * step
    const outline: [number, number][] = [[root, a], [radius, a + step * 0.22], [radius, a + step * 0.45], [root, a + step * 0.67], [root, a + step * 0.84]]
    outline.forEach(([r, b], j) => (i === 0 && j === 0 ? shape.moveTo(Math.cos(b) * r, Math.sin(b) * r) : shape.lineTo(Math.cos(b) * r, Math.sin(b) * r)))
  }
  shape.closePath()
  shape.holes.push(new THREE.Path().absarc(0, 0, radius * 0.18, 0, Math.PI * 2, true))
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 24 })
  g.translate(0, 0, -thickness / 2)
  return g.rotateX(Math.PI / 2)
}

function arrow3d(length: number, radius: number): THREE.BufferGeometry {
  const head = Math.min(length * 0.35, radius * 5)
  const shaft = new THREE.CylinderGeometry(radius, radius, length - head, 20).translate(0, -head / 2, 0)
  const tip = new THREE.ConeGeometry(radius * 2.4, head, 24).translate(0, (length - head) / 2, 0)
  return mergeGeometries([shaft, tip])
}

function geometry(p: Part): THREE.BufferGeometry {
  const [a, b, c, d] = p.size
  switch (p.shape) {
    case 'box':
      return new THREE.BoxGeometry(a, b ?? a, c ?? a)
    case 'cylinder':
      return new THREE.CylinderGeometry(a, a, b ?? a * 2, 40)
    case 'tube': {
      const inner = Math.min(b ?? a * 0.8, a * 0.95), h = c ?? a * 2
      const profile = [[inner, -h / 2], [a, -h / 2], [a, h / 2], [inner, h / 2], [inner, -h / 2]].map(([x, y]) => new THREE.Vector2(x, y))
      return new THREE.LatheGeometry(profile, 48)
    }
    case 'sphere':
      return new THREE.SphereGeometry(a, 32, 20)
    case 'cone':
      return new THREE.ConeGeometry(a, b ?? a * 2, 40)
    case 'torus':
      return new THREE.TorusGeometry(a, b ?? a * 0.25, 16, 56).rotateX(Math.PI / 2)
    case 'capsule':
      return new THREE.CapsuleGeometry(a, b ?? a * 2, 8, 24)
    case 'gear':
      return gear(a, b ?? a * 0.25, c ?? 12)
    case 'spring': {
      const coils = c ?? 6
      return new THREE.TubeGeometry(new Helix(a, b ?? a * 3, coils), Math.ceil(coils * 28), d ?? a * 0.08, 8, false)
    }
    case 'arrow':
      return arrow3d(a, b ?? a * 0.04)
  }
}

const deg = (v: number) => (v * Math.PI) / 180

function move(mover: THREE.Object3D, pivot: THREE.Vector3, m: Motion, seconds: number): void {
  const cycle = seconds * (m.speed ?? 0.5) + (m.phase ?? 0)
  const wave = Math.sin(cycle * Math.PI * 2)
  if (m.kind === 'spin') mover.rotation[m.axis] = cycle * Math.PI * 2
  else if (m.kind === 'swing') mover.rotation[m.axis] = deg(m.amount ?? 20) * wave
  else mover.position[m.axis] = pivot[m.axis] + (m.amount ?? 0.2) * wave
}

// ---- framing

/** A sample of the parts' vertices in world space (box corners overshoot round parts), and with a turntable
 *  the same points turned about y, since the figure will be. */
function silhouette(meshes: THREE.Mesh[], turning: boolean): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false)
    const pos = mesh.geometry.getAttribute('position')
    const stride = Math.max(1, Math.ceil(pos.count / 800))
    for (let i = 0; i < pos.count; i += stride) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld))
  }
  if (!turning) return out
  const axis = new THREE.Vector3(0, 1, 0)
  return [0, 1, 2, 3].flatMap(i => out.map(p => p.clone().applyAxisAngle(axis, (i * Math.PI) / 4)))
}

/** Dollies the camera until the points fill `fillX` × `fillY` of the view (a few passes settle the perspective).
 *  Returns their horizontal span in the view, as fractions of its width. */
function fit(camera: THREE.PerspectiveCamera, points: THREE.Vector3[], fillX: number, fillY: number): [number, number] {
  const v = new THREE.Vector3()
  for (let pass = 0; pass < 4; pass++) {
    camera.updateMatrixWorld()
    let extent = 0
    for (const p of points) {
      v.copy(p).project(camera)
      extent = Math.max(extent, Math.abs(v.x) / fillX, Math.abs(v.y) / fillY)
    }
    camera.position.multiplyScalar(extent)
  }
  camera.updateMatrixWorld()
  let lo = 1, hi = -1
  for (const p of points) {
    v.copy(p).project(camera)
    lo = Math.min(lo, v.x)
    hi = Math.max(hi, v.x)
  }
  return [(lo + 1) / 2, (hi + 1) / 2]
}

// ---- a figure on its card

function build(m: FigureMark, r: Rect, ink: string, host: HTMLElement) {
  const card = document.createElement('div')
  card.className = 'card'
  Object.assign(card.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, opacity: '0' })
  const top = m.title ? TITLE_SPACE : 0
  const view = { w: r.w, h: Math.max(40, r.h - top) }
  const canvas = document.createElement('canvas')
  Object.assign(canvas.style, { top: `${top}px`, width: `${view.w}px`, height: `${view.h}px` })
  card.append(canvas)
  if (m.title) {
    const title = document.createElement('div')
    title.className = 'card-title'
    title.textContent = m.title
    title.style.background = ink
    card.append(title)
  }
  const labelLayer = el('svg', { class: 'card-labels' }, card)
  host.append(card)

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(devicePixelRatio)
  renderer.setSize(view.w, view.h, false)
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight('#ffffff', '#b9b2a4', 1.3))
  const sun = new THREE.DirectionalLight('#ffffff', 2.2)
  sun.position.set(3, 5, 4)
  scene.add(sun)
  const turntable = new THREE.Group()
  const root = new THREE.Group()
  turntable.add(root)
  scene.add(turntable)

  const hull = new THREE.ShaderMaterial({
    uniforms: { thickness: { value: 0.01 }, color: { value: new THREE.Color(INK) } },
    vertexShader: 'uniform float thickness; void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * thickness, 1.0); }',
    fragmentShader: 'uniform vec3 color; void main() { gl_FragColor = vec4(color, 1.0); }',
    side: THREE.BackSide,
  })

  const meshes: THREE.Mesh[] = []
  const movers: { mover: THREE.Object3D; pivot: THREE.Vector3; motion?: Motion }[] = []
  const byId = new Map<string, { mover: THREE.Object3D; pivot: THREE.Vector3 }>()
  m.parts.forEach((p, i) => {
    const geo = geometry(p)
    const opacity = p.opacity ?? 1
    const solid = opacity >= 1
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshToonMaterial({ color: p.color ?? PALETTE[i % PALETTE.length], gradientMap: toonBands, transparent: !solid, opacity, depthWrite: solid }),
    )
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 28), new THREE.LineBasicMaterial({ color: INK, transparent: !solid, opacity: solid ? 1 : 0.45 })))
    if (solid) mesh.add(new THREE.Mesh(geo, hull))
    const pivot = new THREE.Vector3(...((p.pivot ?? [0, 0, 0]) as [number, number, number]))
    mesh.position.copy(pivot).negate()
    const mover = new THREE.Object3D()
    mover.position.copy(pivot)
    mover.add(mesh)
    const holder = new THREE.Object3D()
    holder.position.set(...(p.at as [number, number, number]))
    if (p.rot) holder.rotation.set(deg(p.rot[0]), deg(p.rot[1]), deg(p.rot[2]))
    holder.add(mover)
    root.add(holder)
    meshes.push(mesh)
    movers.push({ mover, pivot, motion: p.motion })
    if (p.id) byId.set(p.id, { mover, pivot })
  })

  // Frame the whole figure at rest, then shrink every part to nothing for the build.
  const bounds = new THREE.Box3().setFromObject(root)
  const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 1e-3)
  root.position.copy(bounds.getCenter(new THREE.Vector3())).negate()
  hull.uniforms.thickness.value = radius * 0.012
  const camera = new THREE.PerspectiveCamera(28, view.w / view.h, radius / 50, radius * 50)
  const yaw = deg(m.view?.yaw ?? 30), pitch = deg(m.view?.pitch ?? 20)
  camera.position.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(radius * 4)
  camera.lookAt(0, 0, 0)
  // With labels, leave side margins for their pills.
  const [spanL, spanR] = fit(camera, silhouette(meshes, !!m.turntable), m.labels?.length ? 0.6 : 0.8, 0.8)
  const figL = spanL * view.w, figR = spanR * view.w
  for (const { mover } of movers) mover.scale.setScalar(1e-4)

  // Labels: an anchor that rides on its part, drawn as a dot, a leader and a pill.
  const labels = (m.labels ?? []).map(l => {
    const target = l.part ? byId.get(l.part) : undefined
    const anchor = new THREE.Object3D()
    const at = new THREE.Vector3(...((l.at ?? [0, 0, 0]) as [number, number, number]))
    if (target) {
      anchor.position.copy(at.sub(target.pivot))
      target.mover.add(anchor)
    } else {
      anchor.position.copy(at)
      root.add(anchor)
    }
    const w = Math.ceil(textWidth(l.text, PILL_FONT)) + 18
    const g = el('g', { opacity: 0 }, labelLayer)
    const line = el('line', { stroke: ink, 'stroke-width': 1.5 }, g)
    const dot = el('circle', { r: 3.5, fill: ink, stroke: '#FFFFFF', 'stroke-width': 1.5 }, g)
    const pill = el('g', {}, g)
    el('rect', { x: 0, y: 0, width: w, height: PILL_H, rx: PILL_H / 2, fill: ink }, pill)
    el('text', { x: w / 2, y: PILL_H / 2, fill: '#FFFFFF', 'font-family': UI_FONT, 'font-size': 12, 'font-weight': 600, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, pill).textContent = l.text
    return { anchor, g, line, dot, pill, w }
  })

  // Each pill goes beside the model on its anchor's side, level with the anchor, stepping up or down off pills
  // already placed.
  const v = new THREE.Vector3()
  const free = (x: number, y: number, w: number, taken: number[][]) =>
    !taken.some(([x0, y0, w0]) => x < x0 + w0 + 4 && x + w + 4 > x0 && y < y0 + PILL_H + 4 && y + PILL_H + 4 > y0)
  function placeLabels(): void {
    const taken: number[][] = []
    for (const l of labels) {
      l.anchor.getWorldPosition(v).project(camera)
      const x = ((v.x + 1) / 2) * view.w, y = ((1 - v.y) / 2) * view.h + top
      const right = x >= (figL + figR) / 2
      const px = clamp(right ? Math.max(x + 22, figR + 10) : Math.min(x - 22 - l.w, figL - 10 - l.w), 6, r.w - l.w - 6)
      const level = y - PILL_H / 2
      let py = clamp(level, top + 4, r.h - PILL_H - 6)
      for (const k of [1, -1, 2, -2, 3, -3, 4, -4]) {
        if (free(px, py, l.w, taken)) break
        py = clamp(level + k * (PILL_H + 4), top + 4, r.h - PILL_H - 6)
      }
      taken.push([px, py, l.w])
      l.dot.setAttribute('cx', String(x))
      l.dot.setAttribute('cy', String(y))
      l.line.setAttribute('x1', String(x))
      l.line.setAttribute('y1', String(y))
      l.line.setAttribute('x2', String(right ? px : px + l.w))
      l.line.setAttribute('y2', String(py + PILL_H / 2))
      l.pill.setAttribute('transform', `translate(${px} ${py})`)
    }
  }

  const born = now()
  let movingSince = 0
  let raf = 0
  const loop = () => {
    const t = now()
    if (movingSince) for (const { mover, pivot, motion } of movers) motion && move(mover, pivot, motion, t - movingSince)
    if (m.turntable) turntable.rotation.y = (t - born) * TURNTABLE
    renderer.render(scene, camera)
    placeLabels()
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)

  const figure = {
    showCard(t: number) {
      card.style.opacity = String(clamp(t * 3, 0, 1))
      card.style.transform = `scale(${0.92 + 0.08 * easeBack(t)})`
    },
    grow(i: number, t: number) {
      movers[i].mover.scale.setScalar(Math.max(1e-4, easeBack(t)))
    },
    showLabel(i: number, t: number) {
      labels[i].g.setAttribute('opacity', String(clamp(t * 2, 0, 1)))
    },
    startMotion() {
      movingSince ||= now()
    },
    dispose() {
      cancelAnimationFrame(raf)
      scene.traverse(o => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
          o.geometry.dispose()
          ;(Array.isArray(o.material) ? o.material : [o.material]).forEach(mat => mat.dispose())
        }
      })
      renderer.dispose()
      card.remove()
    },
  }
  live.add(figure)
  return figure
}

/** Grows a card smaller than the minimum about its centre, keeping it on screen. */
function roomy(r: Rect): Rect {
  const w = Math.min(innerWidth - 12, Math.max(r.w, MIN_CARD.w)), h = Math.min(innerHeight - 12, Math.max(r.h, MIN_CARD.h))
  return { x: clamp(r.x + (r.w - w) / 2, 6, innerWidth - w - 6), y: clamp(r.y + (r.h - h) / 2, 6, innerHeight - h - 6), w, h }
}

export function figureBeats(m: FigureMark, box: Rect, ink: string, host: HTMLElement): Beat[] {
  const r = roomy(box)
  let fig: ReturnType<typeof build> | undefined
  const partDur = clamp(2.4 / m.parts.length, 0.12, 0.35)
  return [
    { dur: 0.35, start: () => (fig = build(m, r, ink, host)), frame: t => fig!.showCard(t) },
    ...m.parts.map((_, i): Beat => ({ dur: partDur, frame: t => fig!.grow(i, t) })),
    ...(m.labels ?? []).map((_, i): Beat => ({ dur: 0.22, frame: t => fig!.showLabel(i, t) })),
    { dur: 0.01, frame: () => fig!.startMotion() },
  ]
}
