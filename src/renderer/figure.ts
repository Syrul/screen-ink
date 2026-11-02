// 3D figures: a small three.js model on a card, drawn like an illustration (toon shading, ink outline and
// creases; metals and glass shine but keep the ink). Parts grow in one by one as beats, labels pop in and follow
// their parts, then motion starts and the steps play: each moves the camera, cuts the model open, pulls it apart or
// fades all but a few parts, while its words are said. The user can drag the card to turn the model and click a
// part to ask about it.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { FigureMark } from '../shared/marks'
import { crankAt, solve, type Mechanism, type Vec } from '../shared/mechanism'
import { clamp, easeBack, easePen, el, now, textWidth, UI_FONT, type Beat } from './common'
import type { Rect } from './shapes'

type Part = FigureMark['parts'][number]
type Motion = NonNullable<Part['motion']>
type Step = NonNullable<FigureMark['steps']>[number]
type Axis = 'x' | 'y' | 'z'

const PALETTE = ['#A9C1DD', '#F2C48D', '#B9DDB5', '#E7A9A3', '#CDBFEA', '#D9D4C7']
const INK = '#30333A'
const TITLE_SPACE = 40
const PILL_H = 22
const PILL_FONT = `600 12px ${UI_FONT}`
const TURNTABLE = 0.25 // radians per second
const MIN_CARD = { w: 380, h: 300 } // points: room for the model and its label pills
const STEP_SECONDS = 1.1 // a step's change, before its hold
const FADED = 0.16 // what's left of a part out of focus
const DRAG_DEGREES = 0.45 // per point dragged

// What a material looks like: metals and glass are lit by a soft room so they shine.
const MATERIALS: Record<string, { color?: string; metalness: number; roughness: number; clearcoat?: number; opacity?: number }> = {
  steel: { color: '#B9C0C8', metalness: 1, roughness: 0.32 },
  brass: { color: '#D2A645', metalness: 1, roughness: 0.3 },
  copper: { color: '#C97B4B', metalness: 1, roughness: 0.32 },
  glass: { color: '#DCEAF2', metalness: 0, roughness: 0.04, clearcoat: 1, opacity: 0.26 },
  rubber: { color: '#36383D', metalness: 0, roughness: 0.92 },
  plastic: { metalness: 0, roughness: 0.38, clearcoat: 0.5 },
}

const live = new Set<{ dispose(): void; card: HTMLElement }>()

/** Disposes the figures in `host`, or all of them. */
export function disposeFigures(host?: HTMLElement): void {
  for (const f of live) {
    if (host && !host.contains(f.card)) continue
    f.dispose()
    live.delete(f)
  }
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
  const [a = 0.5, b, c, d] = p.size ?? []
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
      return new THREE.SphereGeometry(1, 32, 20).scale(a, b ?? a, c ?? a)
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
    case 'lathe': {
      const profile = (p.points ?? [[0.4, -0.5], [0.4, 0.5]]).map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-3), y))
      return new THREE.LatheGeometry(profile, 48)
    }
    case 'extrude': {
      const outline = p.points && p.points.length >= 3 ? p.points : [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]
      const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)))
      const depth = p.size?.[0] ?? 0.2
      return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 16 }).translate(0, 0, -depth / 2)
    }
    case 'pipe': {
      const curve = pipeCurve(p)
      return new THREE.TubeGeometry(curve, clamp(curve.points.length * 18, 32, 600), p.size?.[0] ?? 0.06, 12, curve.closed)
    }
  }
}

/** A pipe's centre line; a path that ends where it starts closes into a loop (a belt, a ring main). */
function pipeCurve(p: Part): THREE.CatmullRomCurve3 {
  const points = (p.path ?? [[0, -0.5, 0], [0, 0.5, 0]]).map(([x, y, z]) => new THREE.Vector3(x, y, z))
  const closed = points.length > 3 && points[0].distanceTo(points[points.length - 1]) < 1e-6
  return new THREE.CatmullRomCurve3(closed ? points.slice(0, -1) : points, closed, 'centripetal')
}

function material(p: Part, i: number): THREE.MeshToonMaterial | THREE.MeshPhysicalMaterial {
  const look = p.material && p.material !== 'matte' ? MATERIALS[p.material] : null
  const color = p.color ?? look?.color ?? PALETTE[i % PALETTE.length]
  const opacity = p.opacity ?? look?.opacity ?? 1
  const solid = opacity >= 1
  if (!look) return new THREE.MeshToonMaterial({ color, gradientMap: toonBands, transparent: !solid, opacity, depthWrite: solid })
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: look.metalness,
    roughness: look.roughness,
    clearcoat: look.clearcoat ?? 0,
    envMapIntensity: 0.9,
    transparent: !solid,
    opacity,
    depthWrite: solid,
  })
}

const deg = (v: number) => (v * Math.PI) / 180
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const frac = (v: number) => v - Math.floor(v)
const vec = (v: Vec) => new THREE.Vector3(v[0], v[1], v[2])
const AXES: Axis[] = ['x', 'y', 'z']
/** The two axes across each axis, in turning order. */
const ACROSS: Record<Axis, [Axis, Axis]> = { x: ['y', 'z'], y: ['z', 'x'], z: ['x', 'y'] }

function move(mover: THREE.Object3D, pivot: THREE.Vector3, m: Motion, seconds: number, phase: number): void {
  const cycle = seconds * (m.speed ?? 0.5) + (m.phase ?? 0) + phase
  const wave = Math.sin(cycle * Math.PI * 2)
  switch (m.kind) {
    case 'spin':
      mover.rotation[m.axis] = cycle * Math.PI * 2
      break
    case 'swing':
      mover.rotation[m.axis] = deg(m.amount ?? 20) * wave
      break
    case 'pendulum': // let go from one side
      mover.rotation[m.axis] = deg(m.amount ?? 20) * Math.cos(cycle * Math.PI * 2)
      break
    case 'bounce': {
      // Dropped from the top; each bounce a parabola, squashed a little as it lands.
      const t = frac(cycle + 0.5) - 0.5
      mover.position[m.axis] = pivot[m.axis] + (m.amount ?? 0.5) * (1 - 4 * t * t)
      const squash = Math.max(0, Math.abs(t) - 0.45) / 0.05
      mover.scale.setScalar(1 + 0.09 * squash)
      mover.scale[m.axis] = 1 - 0.18 * squash
      break
    }
    case 'orbit': {
      const [a, b] = ACROSS[m.axis]
      mover.position[a] = pivot[a] + (m.amount ?? 0.3) * Math.cos(cycle * Math.PI * 2)
      mover.position[b] = pivot[b] + (m.amount ?? 0.3) * wave
      break
    }
    case 'slide':
      mover.position[m.axis] = pivot[m.axis] + (m.amount ?? 0.2) * wave
      break
    case 'flow': // beads, moved by the mechanism
      break
  }
}

/** Moves what the links drive, for the time: rods and sliders by their cranks, springs held to what they hold, beads
 *  round belts and along flowing pipes. Runs after the parts' own motions. */
function mechanism(mech: Mechanism, copiesOf: Piece[][]): (seconds: number) => void {
  const jobs: ((seconds: number) => void)[] = []
  const box = (p: Piece) => (p.mesh.geometry.computeBoundingBox(), p.mesh.geometry.boundingBox!)

  for (const c of mech.cranks) {
    const motion = mech.parts[c.crank].motion!
    const rods = copiesOf[c.rod], sliders = copiesOf[c.slider]
    const copies = mech.parts[c.slider].copies
    // The rod's long side runs pin to slider, stretched to the rod's length; its thinnest side faces along the axle.
    const b = box(rods[0])
    const size = b.getSize(new THREE.Vector3()), middle = b.getCenter(new THREE.Vector3())
    const long = AXES.reduce((a, x) => (size[x] > size[a] ? x : a))
    const [o1, o2] = AXES.filter(x => x !== long)
    const flat = size[o1] <= size[o2] ? o1 : o2
    const third = flat === o1 ? o2 : o1
    const stretch = c.length / Math.max(size[long], 1e-6)
    for (const r of rods) r.mesh.scale[long] = stretch
    middle[long] *= stretch
    const axis = vec(c.axis)
    // Copies round the axle sit a turn apart, so their cranks are too.
    const around = copies?.around ? Math.round(axis[copies.around]) : 0
    const cols = { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() }
    const basis = new THREE.Matrix4()
    jobs.push(seconds => {
      const cycle = seconds * (motion.speed ?? 0.5) + (motion.phase ?? 0)
      const n = Math.min(rods.length, sliders.length)
      for (let i = 0; i < n; i++) {
        const turn = (cycle + (copies?.phase ?? 0) * i - (around * i) / sliders.length) * Math.PI * 2
        const { pin, end, slider } = crankAt(c, turn)
        sliders[i].place.position.set(...slider)
        cols[long].copy(vec(end)).sub(vec(pin)).normalize()
        cols[flat].copy(axis)
        cols[third].crossVectors(cols[long], cols[flat])
        basis.makeBasis(cols.x, cols.y, cols.z)
        if (basis.determinant() < 0) {
          cols[third].negate()
          basis.makeBasis(cols.x, cols.y, cols.z)
        }
        rods[i].place.quaternion.setFromRotationMatrix(basis)
        rods[i].place.position.copy(vec(pin)).add(vec(end)).multiplyScalar(0.5).sub(middle.clone().applyQuaternion(rods[i].place.quaternion))
      }
    })
  }

  // A spring keeps its bottom where it stands and its top where it meets the part it holds.
  const frame = (p: Piece, out: THREE.Matrix4) => {
    p.place.updateMatrix()
    p.mover.updateMatrix()
    return out.multiplyMatrices(p.place.matrix, p.mover.matrix)
  }
  for (const s of mech.stretches) {
    const spring = copiesOf[s.part][0], held = copiesOf[s.to][0]
    const { min, max } = box(spring)
    spring.place.updateMatrix()
    const rest = spring.place.quaternion.clone()
    const bottom = new THREE.Vector3(0, min.y, 0).applyMatrix4(spring.place.matrix)
    const top = new THREE.Vector3(0, max.y, 0).applyMatrix4(spring.place.matrix)
    const along0 = top.clone().sub(bottom)
    const m = new THREE.Matrix4()
    const attach = top.clone().applyMatrix4(frame(held, m).invert())
    const along = new THREE.Vector3(), bend = new THREE.Quaternion()
    jobs.push(() => {
      along.copy(attach).applyMatrix4(frame(held, m)).sub(bottom)
      bend.setFromUnitVectors(along0.clone().normalize(), along.clone().normalize())
      spring.place.quaternion.copy(rest).premultiply(bend)
      const sy = along.length() / along0.length()
      spring.mesh.scale.y = sy
      spring.place.position.copy(bottom).sub(new THREE.Vector3(0, min.y * sy, 0).applyQuaternion(spring.place.quaternion))
    })
  }

  // Beads running round a belt or along a pipe.
  for (const r of mech.runners) {
    const piece = copiesOf[r.part][0]
    const p = piece.part
    const curve = pipeCurve(p)
    const length = curve.getLength()
    const thick = p.size?.[0] ?? 0.06
    const belt = p.material === 'rubber' && curve.closed
    const count = clamp(Math.round(length / (thick * (belt ? 4 : 7))), 8, 90)
    const color = belt ? '#8A929C' : p.material === 'glass' ? '#4F8EDB' : '#FFFFFF'
    const beads = new THREE.InstancedMesh(
      new THREE.SphereGeometry(thick * (belt ? 1.18 : 0.7), 10, 8),
      new THREE.MeshToonMaterial({ color, gradientMap: toonBands, transparent: true }),
      count,
    )
    piece.mesh.add(beads)
    const at = new THREE.Matrix4(), point = new THREE.Vector3()
    jobs.push(seconds => {
      const shift = (seconds * r.speed) / length
      for (let i = 0; i < count; i++) beads.setMatrixAt(i, at.makeTranslation(curve.getPointAt(frac(i / count + shift), point)))
      beads.instanceMatrix.needsUpdate = true
      // Fade and cut with the pipe.
      const mat = piece.mesh.material
      beads.material.opacity = Math.min(1, mat.opacity * (belt ? 1 : 1.6))
      if (beads.material.clippingPlanes !== mat.clippingPlanes) {
        beads.material.clippingPlanes = mat.clippingPlanes
        beads.material.needsUpdate = true
      }
    })
  }
  return seconds => jobs.forEach(j => j(seconds))
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

/** One built part: a copy of a part entry, nested as slot (pulled out when exploded) › copy transform › place › mover
 *  (its motion) › mesh. */
interface Piece {
  part: Part
  slot: THREE.Object3D
  place: THREE.Object3D
  mover: THREE.Object3D
  pivot: THREE.Vector3
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial | THREE.MeshPhysicalMaterial>
  edges: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
  hull: THREE.Mesh | null
  /** Its back faces in a flat, darker colour: what shows as the cut face when it is cut open. */
  inside: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  opacity: number
  phase: number
  /** Where it moves to when fully exploded, from its place. */
  away: THREE.Vector3
  fade: number
}

/** Where the figure is in its steps: what the camera does, and how open, apart and focused the model is. */
interface Pose {
  yaw: number
  pitch: number
  zoom: number
  look: Piece | null
  explode: number
  fades: number[]
  cut: { axis: Axis; at: number; pieces: Set<Piece> } | null
  /** How far the cut has gone in, 0 to 1. */
  cutIn: number
  rate: number
}

export interface FigureHooks {
  /** The user clicked a part: ask about it. */
  ask(question: string): void
  /** Says a step's words, if the voice is on; resolves once they are said. */
  say(text: string): Promise<unknown>
  /** Saves the figure as a 3D model file. */
  save(name: string, usdz: Uint8Array): Promise<unknown>
}

const SHELF = 0.3 // metres: how big a saved model stands, to sit on a table in AR

/** A geometry with `m` built in, its triangles turned back the right way round if `m` mirrors. */
function baked(geo: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(m)
  if (m.determinant() < 0)
    for (const a of Object.values(g.attributes)) {
      const v = a.array, n = a.itemSize
      for (let t = 0; t + 2 < a.count; t += 3)
        for (let k = 0; k < n; k++) [v[(t + 1) * n + k], v[(t + 2) * n + k]] = [v[(t + 2) * n + k], v[(t + 1) * n + k]]
    }
  return g
}

function build(m: FigureMark, mech: Mechanism, r: Rect, ink: string, host: HTMLElement, hooks: FigureHooks) {
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
  const hint = document.createElement('div')
  hint.className = 'card-hint'
  hint.textContent = 'Drag to turn · click a part to ask'
  card.append(hint)
  const tools = document.createElement('div')
  tools.className = 'card-tools'
  const tool = (text: string, title: string, run: (b: HTMLButtonElement) => void) => {
    const b = document.createElement('button')
    b.textContent = text
    b.title = title
    b.addEventListener('click', () => run(b))
    tools.append(b)
  }
  card.append(tools)
  host.append(card)

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(devicePixelRatio)
  renderer.setSize(view.w, view.h, false)
  renderer.setClearColor(0x000000, 0)
  renderer.localClippingEnabled = true

  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight('#ffffff', '#b9b2a4', 1.3))
  const sun = new THREE.DirectionalLight('#ffffff', 2.2)
  sun.position.set(3, 5, 4)
  scene.add(sun)
  let pmrem: THREE.PMREMGenerator | null = null
  if (m.parts.some(p => p.material && p.material !== 'matte')) {
    pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  }
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
  const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6) // world space; far away until a step cuts
  const localClip = new THREE.Plane()

  // ---- the parts, with their copies
  const pieces: Piece[] = []
  m.parts.forEach((p, i) => {
    const geo = geometry(p)
    const copies = p.copies
    const count = copies ? (copies.mirror ? 2 : copies.count) : 1
    for (let k = 0; k < count; k++) {
      const mat = material(p, i) // each copy its own, to fade on its own
      const mesh = new THREE.Mesh(geo, mat)
      const opacity = mat.opacity
      const solid = opacity >= 1
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 28), new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: solid ? 1 : 0.45 }))
      mesh.add(edges)
      const shell = solid ? new THREE.Mesh(geo, hull) : null
      if (shell) mesh.add(shell)
      const inside = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(mat.color).multiplyScalar(0.55), side: THREE.BackSide, visible: false }))
      mesh.add(inside)
      const pivot = new THREE.Vector3(...((p.pivot ?? [0, 0, 0]) as [number, number, number]))
      mesh.position.copy(pivot).negate()
      const mover = new THREE.Object3D()
      mover.position.copy(pivot)
      mover.add(mesh)
      const place = new THREE.Object3D()
      place.position.set(...(p.at as [number, number, number]))
      if (p.rot) place.rotation.set(deg(p.rot[0]), deg(p.rot[1]), deg(p.rot[2]))
      place.add(mover)
      const copy = new THREE.Object3D()
      if (copies?.mirror && k) copy.scale[copies.mirror] = -1
      else if (copies?.around) copy.rotation[copies.around] = (k * Math.PI * 2) / count
      else if (copies?.step) copy.position.set(copies.step[0] * k, copies.step[1] * k, copies.step[2] * k)
      copy.add(place)
      const slot = new THREE.Object3D()
      slot.add(copy)
      root.add(slot)
      pieces.push({ part: p, slot, place, mover, pivot, mesh, edges, hull: shell, inside, opacity, phase: (copies?.phase ?? 0) * k, away: new THREE.Vector3(), fade: 0 })
    }
  })
  const byId = new Map<string, Piece>()
  for (const piece of pieces) if (piece.part.id && !byId.has(piece.part.id)) byId.set(piece.part.id, piece)
  // At rest the figure stands as it will when the motion starts.
  const drive = mechanism(mech, m.parts.map(p => pieces.filter(q => q.part === p)))
  for (const p of pieces) p.part.motion && move(p.mover, p.pivot, p.part.motion, 0, p.phase)
  drive(0)

  // Frame the whole figure at rest, then shrink every part to nothing for the build.
  const bounds = new THREE.Box3().setFromObject(root)
  const center = bounds.getCenter(new THREE.Vector3())
  const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 1e-3)
  for (const piece of pieces) {
    // Exploded, a part moves straight out from the middle, further the further out it sits.
    const out = new THREE.Box3().setFromObject(piece.mesh).getCenter(new THREE.Vector3()).sub(center)
    if (out.length() > radius * 0.04) piece.away.copy(out).multiplyScalar(0.45).add(out.clone().setLength(radius * 0.2))
  }
  root.position.copy(center).negate()
  hull.uniforms.thickness.value = radius * 0.012
  const camera = new THREE.PerspectiveCamera(28, view.w / view.h, radius / 50, radius * 50)
  const pose: Pose = { yaw: m.view?.yaw ?? 30, pitch: m.view?.pitch ?? 20, zoom: 1, look: null, explode: 0, fades: pieces.map(() => 0), cut: null, cutIn: 0, rate: 1 }
  const direction = (yaw: number, pitch: number) =>
    new THREE.Vector3(Math.sin(deg(yaw)) * Math.cos(deg(pitch)), Math.sin(deg(pitch)), Math.cos(deg(yaw)) * Math.cos(deg(pitch)))
  camera.position.copy(direction(pose.yaw, pose.pitch)).multiplyScalar(radius * 4)
  camera.lookAt(0, 0, 0)
  // With labels, leave side margins for their pills.
  const [spanL, spanR] = fit(camera, silhouette(pieces.map(p => p.mesh), !!m.turntable), m.labels?.length ? 0.6 : 0.8, 0.8)
  const distance = camera.position.length()
  let figL = spanL * view.w, figR = spanR * view.w
  for (const { mover } of pieces) mover.scale.setScalar(1e-4)

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
    return { anchor, g, line, dot, pill, w, piece: target, shown: 0 }
  })

  // Each pill goes beside the model on its anchor's side, level with the anchor, stepping up or down off pills
  // already placed.
  const v = new THREE.Vector3()
  const free = (x: number, y: number, w: number, taken: number[][]) =>
    !taken.some(([x0, y0, w0]) => x < x0 + w0 + 4 && x + w + 4 > x0 && y < y0 + PILL_H + 4 && y + PILL_H + 4 > y0)
  const span = new THREE.Box3()
  const corner = new THREE.Vector3()
  /** Where the model spans across the view now, as it turns, zooms and comes apart, so pills go beside it. */
  function measure(): void {
    span.setFromObject(root)
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? span.max.x : span.min.x, i & 2 ? span.max.y : span.min.y, i & 4 ? span.max.z : span.min.z).project(camera)
      lo = Math.min(lo, corner.x)
      hi = Math.max(hi, corner.x)
    }
    // Box corners overshoot round parts, so pull in a little; never past the first framing's own margins.
    figL = clamp(((lo + 1) / 2 + 0.04) * view.w, spanL * view.w * 0.5, view.w * 0.45)
    figR = clamp(((hi + 1) / 2 - 0.04) * view.w, view.w * 0.55, view.w - (1 - spanR) * view.w * 0.5)
  }

  function placeLabels(): void {
    measure()
    const taken: number[][] = []
    for (const l of labels) {
      l.g.setAttribute('opacity', String(l.shown * (1 - (l.piece?.fade ?? 0) * 0.75)))
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

  // ---- the pose, applied every frame

  const lookAt = new THREE.Vector3()
  const lookFrom = new THREE.Vector3()
  let lookBlend = 1 // how far the camera has turned from lookFrom to its new target

  function cutFace(a: Axis): number {
    // The half nearest the camera goes, so the cut faces the viewer.
    const eye = root.worldToLocal(camera.position.clone())
    return eye[a] >= center[a] ? 1 : -1
  }

  function apply(): void {
    // Camera: round its target at the pose's angle, closer as it zooms, and back as the parts come apart (a part
    // moves out by up to 0.65 of the figure's radius).
    const target = pose.look ? pose.look.mesh.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3()
    lookAt.copy(lookFrom).lerp(target, lookBlend)
    camera.position.copy(direction(pose.yaw, pose.pitch)).multiplyScalar((distance * (1 + 0.65 * pose.explode)) / pose.zoom).add(lookAt)
    camera.lookAt(lookAt)
    camera.updateMatrixWorld()

    pieces.forEach((piece, i) => {
      piece.slot.position.copy(piece.away).multiplyScalar(pose.explode)
      const fade = (piece.fade = pose.fades[i])
      const cut = !!pose.cut?.pieces.has(piece) && pose.cutIn > 0
      const mat = piece.mesh.material
      mat.opacity = piece.opacity * lerp(1, FADED, fade)
      if (mat.transparent !== mat.opacity < 1) {
        // Whether it's see-through is built into its shader, so a change rebuilds that.
        mat.transparent = mat.opacity < 1
        mat.depthWrite = !mat.transparent
        mat.needsUpdate = true
      }
      piece.edges.material.opacity = (piece.opacity < 1 ? 0.45 : 1) * lerp(1, FADED, fade)
      if (piece.hull) piece.hull.visible = fade < 0.5 && !cut
      piece.inside.material.visible = cut && piece.opacity >= 1 && fade < 0.5
      const planes = cut ? [clip] : []
      if (mat.clippingPlanes?.length !== planes.length) {
        mat.clippingPlanes = planes
        piece.edges.material.clippingPlanes = planes
        piece.inside.material.clippingPlanes = planes
        mat.needsUpdate = piece.edges.material.needsUpdate = piece.inside.material.needsUpdate = true
      }
    })
    if (pose.cut) {
      const { axis, at } = pose.cut
      const face = cutFace(axis)
      const edge = face > 0 ? bounds.max[axis] + radius * 0.05 : bounds.min[axis] - radius * 0.05
      const n = new THREE.Vector3()
      n[axis] = -face
      localClip.set(n, face * lerp(edge, at, pose.cutIn))
      root.updateMatrixWorld()
      clip.copy(localClip).applyMatrix4(root.matrixWorld)
    }
  }

  // ---- steps

  function stepTo(s: Step): (t: number) => void {
    const from = { ...pose, fades: [...pose.fades] }
    const to = { yaw: s.view?.yaw ?? pose.yaw, pitch: s.view?.pitch ?? pose.pitch, zoom: s.view?.zoom ?? pose.zoom, explode: s.explode ?? pose.explode }
    const fades = s.focus
      ? pieces.map(p => (s.focus!.length && !(p.part.id && s.focus!.includes(p.part.id)) ? 1 : 0))
      : pose.fades
    if (s.look) {
      lookFrom.copy(lookAt)
      lookBlend = 0
      pose.look = s.look === 'all' ? null : (byId.get(s.look) ?? null)
    }
    const look = !!s.look
    // A new cut sweeps in from the edge; 'off' sweeps the old one out.
    let cutTo = pose.cutIn
    if (s.cut && s.cut.axis !== 'off') {
      const ids = s.cut.parts
      const axis = s.cut.axis
      pose.cut = { axis, at: s.cut.at ?? center[axis], pieces: new Set(pieces.filter(p => !ids?.length || (p.part.id && ids.includes(p.part.id)))) }
      from.cutIn = 0
      cutTo = 1
    } else if (s.cut?.axis === 'off') cutTo = 0
    if (s.motion) pose.rate = s.motion === 'pause' ? 0 : s.motion === 'slow' ? 0.25 : 1
    return t => {
      const e = easePen(t)
      pose.yaw = lerp(from.yaw, to.yaw, e)
      pose.pitch = lerp(from.pitch, to.pitch, e)
      pose.zoom = lerp(from.zoom, to.zoom, e)
      pose.explode = lerp(from.explode, to.explode, e)
      pose.fades = from.fades.map((f, i) => lerp(f, fades[i], e))
      pose.cutIn = lerp(from.cutIn, cutTo, e)
      if (look) lookBlend = e
      if (t >= 1 && cutTo === 0) pose.cut = null
    }
  }

  // ---- replaying the steps, saving the model

  const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
  /** Plays a step's change over its time, frame by frame. */
  const animate = (play: (t: number) => void) =>
    new Promise<void>(done => {
      const from = now()
      const frame = () => {
        const t = clamp((now() - from) / STEP_SECONDS, 0, 1)
        play(t)
        if (t < 1) requestAnimationFrame(frame)
        else done()
      }
      requestAnimationFrame(frame)
    })
  let tour = 0
  async function replay(): Promise<void> {
    const run = ++tour
    const home = m.view ?? {}
    await animate(stepTo({ view: { yaw: home.yaw ?? 30, pitch: home.pitch ?? 20, zoom: 1 }, look: 'all', explode: 0, focus: [], cut: { axis: 'off' }, motion: 'play' }))
    for (const s of m.steps ?? []) {
      if (run !== tour) return
      await Promise.all([animate(stepTo(s)), s.say ? hooks.say(s.say) : null])
      await wait((s.hold ?? 0) * 1000)
    }
  }

  /** The model as it stands, put together, as USDZ: Quick Look opens it, and an iPhone stands it on a table. */
  async function exportModel(): Promise<Uint8Array> {
    const out = new THREE.Group()
    const apart = pieces.map(p => p.slot.position.clone())
    for (const p of pieces) p.slot.position.set(0, 0, 0)
    root.updateMatrixWorld(true)
    const toRoot = root.matrixWorld.clone().invert()
    const m4 = new THREE.Matrix4()
    for (const p of pieces) {
      const mat = p.mesh.material
      const look = new THREE.MeshStandardMaterial({
        color: mat.color,
        metalness: 'metalness' in mat ? mat.metalness : 0,
        roughness: 'roughness' in mat ? mat.roughness : 0.75,
        transparent: p.opacity < 1,
        opacity: p.opacity,
      })
      out.add(new THREE.Mesh(baked(p.mesh.geometry, m4.multiplyMatrices(toRoot, p.mesh.matrixWorld)), look))
    }
    pieces.forEach((p, i) => p.slot.position.copy(apart[i]))
    // Standing on the floor, centred, at tabletop size.
    const b = new THREE.Box3().setFromObject(out)
    const size = b.getSize(new THREE.Vector3())
    const fit = SHELF / Math.max(size.x, size.y, size.z, 1e-6)
    out.scale.setScalar(fit)
    out.position.set(-(b.min.x + size.x / 2) * fit, -b.min.y * fit, -(b.min.z + size.z / 2) * fit)
    const scene = new THREE.Scene().add(out)
    scene.updateMatrixWorld(true)
    const bytes = await new USDZExporter().parseAsync(scene)
    out.traverse(o => o instanceof THREE.Mesh && (o.geometry.dispose(), o.material.dispose()))
    return bytes
  }

  tool('Replay', 'Walk through the steps again', () => void replay())
  tool('Save 3D', 'Save as a 3D model (USDZ) in Downloads', b => {
    b.disabled = true
    void exportModel()
      .then(bytes => hooks.save(m.title ?? 'figure', bytes))
      .catch(e => console.error('screen-ink: saving the figure failed', e))
      .finally(() => (b.disabled = false))
  })

  // ---- turning by drag, asking by click

  const pointer = new THREE.Vector2()
  const ray = new THREE.Raycaster()
  let hovered: Piece | null = null
  let turning = !!m.turntable

  function pieceAt(e: PointerEvent): Piece | null {
    const b = canvas.getBoundingClientRect()
    pointer.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1)
    ray.setFromCamera(pointer, camera)
    const shown = pieces.filter(p => p.fade < 0.5 && p.mover.scale.x > 0.5).map(p => p.mesh)
    // The first part hit, passing over what a cut has taken away.
    for (const h of ray.intersectObjects(shown, false)) {
      const piece = pieces.find(p => p.mesh === h.object)!
      if (!(pose.cut?.pieces.has(piece) && pose.cutIn > 0) || clip.distanceToPoint(h.point) >= 0) return piece
    }
    return null
  }

  function name(piece: Piece): string {
    const label = m.labels?.find(l => l.part && l.part === piece.part.id)
    return label?.text ?? piece.part.id ?? `${piece.part.material && piece.part.material !== 'matte' ? `${piece.part.material} ` : ''}${piece.part.shape}`
  }

  function hover(piece: Piece | null): void {
    if (piece === hovered) return
    for (const p of [hovered, piece]) {
      if (!p) continue
      const mat = p.mesh.material
      mat.emissive.set(p === piece ? '#3a2a20' : '#000000')
    }
    hovered = piece
    canvas.style.cursor = piece ? 'pointer' : 'grab'
    hint.textContent = piece ? `Click to ask about the ${name(piece)}` : 'Drag to turn · click a part to ask'
  }

  let drag: { x: number; y: number; moved: number } | null = null
  canvas.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, moved: 0 }
    canvas.setPointerCapture(e.pointerId)
    card.classList.add('dragging')
  })
  canvas.addEventListener('pointermove', e => {
    if (!drag) return hover(pieceAt(e))
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y
    drag.moved += Math.abs(dx) + Math.abs(dy)
    drag.x = e.clientX
    drag.y = e.clientY
    if (drag.moved < 4) return
    turning = false
    pose.yaw -= dx * DRAG_DEGREES
    pose.pitch = clamp(pose.pitch + dy * DRAG_DEGREES, -85, 85)
    hover(null)
  })
  canvas.addEventListener('pointerup', e => {
    const click = drag && drag.moved < 4
    drag = null
    card.classList.remove('dragging')
    if (!click) return
    const piece = pieceAt(e)
    if (!piece) return
    const what = name(piece)
    hint.textContent = `Asking about the ${what}…`
    hooks.ask(`${m.title ? `In the figure “${m.title}”, t` : 'T'}ell me about the ${what}: what it does, and how it works with the parts around it.`)
  })
  canvas.addEventListener('pointerleave', () => !drag && hover(null))

  // ---- the loop

  const born = now()
  let movingSince = 0
  let motionTime = 0
  let last = now()
  let raf = 0
  const loop = () => {
    const t = now()
    if (movingSince) {
      motionTime += (t - last) * pose.rate
      for (const p of pieces) p.part.motion && move(p.mover, p.pivot, p.part.motion, motionTime, p.phase)
      drive(motionTime)
    }
    last = t
    if (turning) turntable.rotation.y = (t - born) * TURNTABLE
    apply()
    renderer.render(scene, camera)
    placeLabels()
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)

  const figure = {
    card,
    showCard(t: number) {
      card.style.opacity = String(clamp(t * 3, 0, 1))
      card.style.transform = `scale(${0.92 + 0.08 * easeBack(t)})`
    },
    grow(i: number, t: number) {
      // A part and its copies grow together.
      pieces.forEach(p => p.part === m.parts[i] && p.mover.scale.setScalar(Math.max(1e-4, easeBack(t))))
    },
    showLabel(i: number, t: number) {
      labels[i].shown = clamp(t * 2, 0, 1)
    },
    startMotion() {
      movingSince ||= now()
    },
    ready() {
      card.classList.add('ready')
    },
    stepTo,
    dispose() {
      cancelAnimationFrame(raf)
      scene.traverse(o => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
          o.geometry.dispose()
          ;(Array.isArray(o.material) ? o.material : [o.material]).forEach(mat => mat.dispose())
        }
      })
      scene.environment?.dispose()
      pmrem?.dispose()
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

export function figureBeats(figure: FigureMark, box: Rect, ink: string, host: HTMLElement, hooks: FigureHooks): Beat[] {
  const mech = solve(figure)
  const m = { ...figure, parts: mech.parts }
  const r = roomy(box)
  let fig: ReturnType<typeof build> | undefined
  const partDur = clamp(2.4 / m.parts.length, 0.12, 0.35)
  return [
    { dur: 0.35, start: () => (fig = build(m, mech, r, ink, host, hooks)), frame: t => fig!.showCard(t) },
    ...m.parts.map((_, i): Beat => ({ dur: partDur, frame: t => fig!.grow(i, t) })),
    ...(m.labels ?? []).map((_, i): Beat => ({ dur: 0.22, frame: t => fig!.showLabel(i, t) })),
    { dur: 0.01, frame: () => fig!.startMotion() },
    ...(m.steps ?? []).map((s): Beat => {
      const dur = STEP_SECONDS + (s.hold ?? 0)
      let play: (t: number) => void = () => {}
      return { dur, say: s.say, start: () => (play = fig!.stepTo(s)), frame: t => play(clamp((t * dur) / STEP_SECONDS, 0, 1)) }
    }),
    { dur: 0.01, frame: () => fig!.ready() },
  ]
}
