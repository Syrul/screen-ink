// The build panel's 3D view: a step of the instructions drawn from the set's LDraw model, the model built so far and
// the step's new parts dropping into place, lit up as they land and outlined in the ink's colour after (their own
// colours stay true, as the step's words name them). The parts come once per model from the main process, packed
// into one text, so nothing is fetched here.
// Drag to turn it, scroll to zoom, click to see the new parts drop in again; the angle it's seen from stays from step
// to step.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js'
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js'
import type { BuildModel, BuildParts } from '../shared/build'

const DROP_MS = 650 // a new part falling into place
const STAGGER_MS = 45 // between one part starting to fall and the next
const MAX_STAGGER_MS = 700
const GLOW_MS = 1800 // new parts' glow as they land, fading
const GLOW = 0.5 // how strongly, at first
const OUTLINE = 1 // how far the outline around a new part reaches, in LDraw units (a stud is 20)
const FIRST_VIEW = new THREE.Vector3(-1, 0.9, 1.5).normalize() // from the front left, above
const FIT = 1.1 // room around the model
const CLICK_PX = 4 // the most a click moves

let renderer: THREE.WebGLRenderer | null = null
let controls: OrbitControls | null = null
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(30, 1, 1, 1e6)

let library: { key: string; ready: Promise<{ loader: LDrawLoader; colours: string } | null> } | null = null
let parts: (key: string) => Promise<BuildParts | null> = async () => null
let model: THREE.Group | null = null
let drawn = '' // the step drawn
let drawing = 0 // the latest step asked for
let seen = '' // the model the angle is kept for

let drops: { o: THREE.Object3D; from: THREE.Vector3; to: THREE.Vector3; after: number }[] = []
let lit: THREE.Material[] = [] // the new parts' own materials, and their outline's
let glows: THREE.MeshStandardMaterial[] = []
let started = 0
let frame = 0

/** Where the parts of a model come from. */
export const connect = (fn: (key: string) => Promise<BuildParts | null>) => void (parts = fn)

/** The 3D view's canvas, made the first time it's needed. */
export function canvas(): HTMLCanvasElement {
  return init().domElement
}

function init(): THREE.WebGLRenderer {
  if (renderer) return renderer
  const r = (renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }))
  r.setPixelRatio(devicePixelRatio)
  r.domElement.className = 'build-3d'
  r.domElement.title = 'Drag to turn it, scroll to zoom, click to see the new parts again'
  scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture
  const sun = new THREE.DirectionalLight(0xffffff, 1.4)
  sun.position.set(-1, 2, 1.5)
  scene.add(sun)
  controls = new OrbitControls(camera, r.domElement)
  controls.addEventListener('change', render)
  // While it's turned, the mouse stays with the page even off the panel.
  controls.addEventListener('start', () => r.domElement.closest('#build')?.classList.add('dragging'))
  controls.addEventListener('end', () => r.domElement.closest('#build')?.classList.remove('dragging'))
  let down: [number, number] | null = null
  r.domElement.addEventListener('pointerdown', e => (down = [e.clientX, e.clientY]))
  r.domElement.addEventListener('pointerup', e => {
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < CLICK_PX) play()
    down = null
  })
  return r
}

const read = (loader: LDrawLoader, text: string) => new Promise<THREE.Group>((resolve, reject) => loader.parse(text, resolve, reject))

/** A loader that knows every part of model `key`. */
function loaderFor(key: string) {
  if (library?.key !== key) {
    const ready = parts(key).then(async p => {
      if (!p) return null
      const loader = new LDrawLoader()
      loader.setConditionalLineMaterial(LDrawConditionalLineMaterial)
      await read(loader, p.pack) // its files are kept for the steps to use
      return { loader, colours: p.colours }
    })
    library = { key, ready: ready.catch(() => null) }
  }
  return library.ready
}

/** Draws step `m`, its new parts lit in `ink`. Resolves whether it could (false too when another step came since). */
export async function draw(m: BuildModel, ink: string): Promise<boolean> {
  init()
  const id = `${m.key}\n${ink}\n${m.old}\n${m.added}`
  if (id === drawn) return true
  const ticket = ++drawing
  const lib = await loaderFor(m.key)
  if (!lib || ticket !== drawing) return false
  let group: THREE.Group
  try {
    // A STEP between them: the loader numbers the new parts' groups 1.
    group = await read(lib.loader, `${lib.colours}\n${m.old}\n0 STEP\n${m.added}\n`)
  } catch {
    return false
  }
  if (ticket !== drawing) return false
  group.rotation.x = Math.PI // LDraw's up is -y
  if (model) scene.remove(model)
  for (const m of lit) m.dispose()
  model = group
  scene.add(group)
  drawn = id
  fit(group, m.key)
  dropIn(group, new THREE.Color(ink))
  return true
}

/** Frames the model, from the angle it was seen from (unless it's a new model): as near as its corners all show. */
function fit(group: THREE.Group, key: string): void {
  group.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(group)
  if (box.isEmpty()) return
  const view = key === seen ? camera.position.clone().sub(controls!.target).normalize() : FIRST_VIEW.clone()
  seen = key
  const center = box.getCenter(new THREE.Vector3())
  const right = new THREE.Vector3().crossVectors(camera.up, view).normalize()
  const up = new THREE.Vector3().crossVectors(view, right)
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
  const tanX = tanY * camera.aspect
  let d = 1
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center)
    const z = p.dot(view) // towards the camera
    d = Math.max(d, z + Math.abs(p.dot(right)) / tanX, z + Math.abs(p.dot(up)) / tanY)
  }
  d *= FIT
  controls!.target.copy(center)
  camera.position.copy(center).addScaledVector(view, d)
  camera.near = d / 100
  camera.far = d * 100
  camera.updateProjectionMatrix()
  controls!.update()
}

/** The step's new parts: outlined in the ink, and falling into place one after another, lit up as they land. */
function dropIn(group: THREE.Group, ink: THREE.Color): void {
  const added = group.children.filter(c => c.userData.buildingStep >= 1)
  const height = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3()).y
  const fall = Math.max(height * 0.5, 40) // in LDraw units: two studs, at least
  const own = new Map<THREE.Material, THREE.MeshStandardMaterial>()
  const light = (m: THREE.Material) => {
    if (!(m instanceof THREE.MeshStandardMaterial)) return m
    let l = own.get(m)
    if (!l) {
      l = m.clone()
      l.emissive = ink.clone()
      own.set(m, l)
    }
    return l
  }
  const line = new THREE.MeshBasicMaterial({ color: ink, side: THREE.BackSide })
  for (const part of added) {
    part.traverse(o => {
      if (o instanceof THREE.Mesh) o.material = Array.isArray(o.material) ? o.material.map(light) : light(o.material)
    })
    outline(part, line)
  }
  glows = [...own.values()]
  lit = [line, ...glows]
  // Up is -y in the model's own frame.
  drops = added.map((o, i) => ({ o, to: o.position.clone(), from: o.position.clone().setY(o.position.y - fall), after: Math.min(i * STAGGER_MS, MAX_STAGGER_MS) }))
  play()
}

/**
 * Outlines a part: its shape again, a little bigger each way and seen from inside, so only a rim of it shows around
 * the part. It moves with the part.
 */
function outline(part: THREE.Object3D, material: THREE.Material): void {
  part.updateMatrixWorld(true)
  const into = part.matrixWorld.clone().invert()
  const box = new THREE.Box3()
  const shell = new THREE.Group()
  part.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return
    const at = into.clone().multiply(o.matrixWorld)
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
    box.union(o.geometry.boundingBox!.clone().applyMatrix4(at))
    const copy = new THREE.Mesh(o.geometry, material)
    copy.applyMatrix4(at)
    shell.add(copy)
  })
  if (box.isEmpty()) return
  const size = box.getSize(new THREE.Vector3())
  const grow = new THREE.Vector3(1 + (2 * OUTLINE) / Math.max(size.x, 1), 1 + (2 * OUTLINE) / Math.max(size.y, 1), 1 + (2 * OUTLINE) / Math.max(size.z, 1))
  // Grown about the part's middle.
  shell.scale.copy(grow)
  shell.position.copy(box.getCenter(new THREE.Vector3()).multiply(new THREE.Vector3(1, 1, 1).sub(grow)))
  part.add(shell)
}

/** Drops the new parts in, from the top. */
function play(): void {
  for (const d of drops) d.o.position.copy(d.from)
  started = performance.now()
  cancelAnimationFrame(frame)
  tick()
}

const ease = (k: number) => 1 - (1 - k) ** 3

function tick(): void {
  const t = performance.now() - started
  let falling = false
  for (const d of drops) {
    const k = Math.min(1, Math.max(0, (t - d.after) / DROP_MS))
    d.o.position.lerpVectors(d.from, d.to, ease(k))
    falling ||= k < 1
  }
  const g = Math.min(1, t / GLOW_MS)
  for (const m of glows) m.emissiveIntensity = GLOW * (1 - ease(g))
  render()
  frame = falling || g < 1 ? requestAnimationFrame(tick) : 0
}

function render(): void {
  renderer?.render(scene, camera)
}

/** Sizes the view, in CSS pixels. */
export function resize(width: number, height: number): void {
  const r = init()
  const [w, h] = [Math.max(1, Math.round(width)), Math.max(1, Math.round(height))]
  if (r.domElement.width === Math.round(w * r.getPixelRatio()) && r.domElement.height === Math.round(h * r.getPixelRatio())) return
  r.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  if (model) fit(model, seen)
  render()
}
