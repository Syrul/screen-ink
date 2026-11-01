// Mechanisms: how a figure's linked parts drive each other. From the links, screen-ink moves meshing gears to
// touch with their teeth between each other's, gives every driven part its speed, direction and head start, works
// out how a crank moves its rod and piston, and times pendulums and bounces by gravity, so the figure moves as the
// real thing would. Pure numbers: the renderer moves the parts by it, and the check reports what it couldn't make
// work.
import type { FigureMark } from './marks'

type Part = FigureMark['parts'][number]
export type Vec = [number, number, number]
export type Axis = 'x' | 'y' | 'z'

export const GRAVITY = 9.81 // figure units taken as metres
const ROOT = 0.86 // a gear's root circle, as a fraction of its radius (see the renderer's gear)
const TOOTH = 0.335 // where a tooth's middle is, as a fraction of one tooth's turn from its start
const FASTEST = 2.5 // turns per second: a linked set is slowed until its fastest part turns no faster
const BELT = 0.07 // a belt's thickness, as a fraction of the smaller pulley's radius

/** A crank driving a rod and a slider, in the figure's frame: the crank turns about `axis` through `centre`; at
 *  angle 0 its pin points along `u`, toward the slider. */
export interface Crank {
  crank: number
  rod: number
  slider: number
  centre: Vec
  axis: Vec
  u: Vec
  /** The slider's offset along the axis from the crank's middle. */
  offset: number
  /** The rod's: in front of the crank's face, so the rod doesn't run through it. */
  rodOffset: number
  throw: number
  /** The rod's length, pin to slider. */
  length: number
}

/** Something running round a closed path: a belt's ribs. Speed in figure units per second. */
export interface Runner {
  part: number
  speed: number
}

export interface Mechanism {
  /** The parts, moved and given their motions; belts are added at the end. */
  parts: Part[]
  cranks: Crank[]
  /** Springs held between where they stand and a moving part. */
  stretches: { part: number; to: number }[]
  runners: Runner[]
  /** What couldn't be made to work, in words for whoever drew it. */
  problems: string[]
}

// ---- small vector maths

const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: Vec) => Math.hypot(a[0], a[1], a[2])
const unit = (a: Vec): Vec => scale(a, 1 / (len(a) || 1))
const AXES: Record<Axis, Vec> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
const frac = (v: number) => v - Math.floor(v)

/** Turns v by a part's rot (degrees, applied as three.js does for Euler order XYZ: z first, then y, then x). */
function turn(v: Vec, rot: number[] | undefined): Vec {
  if (!rot) return v
  const [a, b, c] = rot.map(d => (d * Math.PI) / 180)
  let [x, y, z] = v
  ;[x, y] = [x * Math.cos(c) - y * Math.sin(c), x * Math.sin(c) + y * Math.cos(c)]
  ;[x, z] = [x * Math.cos(b) + z * Math.sin(b), -x * Math.sin(b) + z * Math.cos(b)]
  ;[y, z] = [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)]
  return [x, y, z]
}

/** The reverse of turn. */
function unturn(v: Vec, rot: number[] | undefined): Vec {
  if (!rot) return v
  const [a, b, c] = rot.map(d => (-d * Math.PI) / 180)
  let [x, y, z] = v
  ;[y, z] = [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)]
  ;[x, z] = [x * Math.cos(b) + z * Math.sin(b), -x * Math.sin(b) + z * Math.cos(b)]
  ;[x, y] = [x * Math.cos(c) - y * Math.sin(c), x * Math.sin(c) + y * Math.cos(c)]
  return [x, y, z]
}

// ---- what a part is, for driving

export function radiusOf(p: Part): number {
  const [a = 0.5, b, c] = p.size ?? []
  switch (p.shape) {
    case 'box':
      return Math.max(a, c ?? a) / 2
    case 'torus':
      return a + (b ?? a * 0.25)
    case 'lathe':
      return Math.max(...(p.points ?? [[0.4, 0]]).map(([r]) => r))
    case 'extrude':
      return Math.max(...(p.points ?? [[0.5, 0.5]]).map(([x, y]) => Math.hypot(x, y)))
    default:
      return a
  }
}

/** How thick a part is along y, the axis round shapes stand along. */
function thicknessOf(p: Part): number {
  const [a = 0.5, b, c] = p.size ?? []
  switch (p.shape) {
    case 'cylinder':
    case 'cone':
      return b ?? a * 2
    case 'gear':
      return b ?? a * 0.25
    case 'tube':
      return c ?? a * 2
    case 'torus':
      return (b ?? a * 0.25) * 2
    case 'box':
      return b ?? a
    case 'sphere':
      return (b ?? a) * 2
    case 'lathe': {
      const ys = (p.points ?? [[0, 0]]).map(([, y]) => y)
      return Math.max(...ys) - Math.min(...ys)
    }
    default:
      return a * 2
  }
}

/** How thin a part is across: a rod's width. */
const thinnessOf = (p: Part) => (p.shape === 'box' ? Math.min(...(p.size ?? [0.1])) : radiusOf(p) * 2)

export const teethOf = (p: Part) => Math.min(60, Math.max(6, Math.round(p.size?.[2] ?? 12)))

const spinAxis = (p: Part): Axis => p.motion?.axis ?? 'y'
/** The axis a part turns about, in the figure's frame. */
const axisOf = (p: Part): Vec => turn(AXES[spinAxis(p)], p.rot)
/** The point it turns about, in the figure's frame. */
const centreOf = (p: Part): Vec => add(p.at as Vec, turn((p.pivot ?? [0, 0, 0]) as Vec, p.rot))
/** v with its part along `axis` taken out. */
const across = (v: Vec, axis: Vec): Vec => sub(v, scale(axis, dot(v, axis)))

export function solve(m: Pick<FigureMark, 'parts' | 'links'>): Mechanism {
  const parts: Part[] = m.parts.map(p => ({ ...p, at: [...p.at], motion: p.motion && { ...p.motion } }))
  const problems: string[] = []
  const index = new Map<string, number>()
  parts.forEach((p, i) => p.id && !index.has(p.id) && index.set(p.id, i))
  const find = (id: string, what: string): number => {
    const i = index.get(id)
    if (i === undefined) problems.push(`The ${what} "${id}" isn't a part's id.`)
    return i ?? -1
  }
  type Link = NonNullable<FigureMark['links']>[number] & { ids: number[] }
  const links = (m.links ?? []).flatMap((l): Link[] => {
    if (l.kind === 'crank') {
      const ids = [find(l.crank, 'crank'), find(l.rod, 'rod'), find(l.slider, 'slider')]
      return ids.includes(-1) ? [] : [{ ...l, ids }]
    }
    if (l.kind === 'stretch') {
      const ids = [find(l.part, 'spring'), find(l.to, 'part the spring holds')]
      return ids.includes(-1) ? [] : [{ ...l, ids }]
    }
    const ids = [find(l.a, `${l.kind}'s first part`), find(l.b, `${l.kind}'s second part`)]
    return ids.includes(-1) || ids[0] === ids[1] ? [] : [{ ...l, ids }]
  })
  const named = (i: number) => parts[i].id ?? `part ${i + 1}`

  // Parts on one shaft move together when one of them is moved.
  const shafts = new Map<number, Set<number>>()
  for (const l of links) {
    if (l.kind !== 'shaft') continue
    const [a, b] = l.ids
    const group = new Set([...(shafts.get(a) ?? [a]), ...(shafts.get(b) ?? [b])])
    for (const i of group) shafts.set(i, group)
  }
  const shift = (i: number, by: Vec) => {
    for (const j of shafts.get(i) ?? [i]) parts[j].at = add(parts[j].at as Vec, by)
  }

  // ---- place meshing gears to touch: b moves to a, unless something already placed b
  const placed = new Set<number>()
  for (const l of links) {
    if (l.kind !== 'mesh') continue
    let [a, b] = l.ids
    if (placed.has(b) && !placed.has(a)) [a, b] = [b, a]
    const pa = parts[a], pb = parts[b]
    const gears = pa.shape === 'gear' && pb.shape === 'gear'
    if (gears) {
      // Meshing teeth are the same size, so their counts go as the radii: keep the counts (they set the ratio)
      // and size b's radius to match a's teeth.
      const want = (radiusOf(pa) * teethOf(pb)) / teethOf(pa)
      if (Math.abs(want / radiusOf(pb) - 1) > 0.04) pb.size = [want, ...(pb.size ?? []).slice(1)]
    }
    const ra = radiusOf(pa), rb = radiusOf(pb)
    const distance = gears ? ra + rb - (1 - ROOT) * 0.85 * Math.min(ra, rb) : ra + rb
    const axis = axisOf(pa)
    const ca = centreOf(pa), cb = centreOf(pb)
    const off = sub(cb, ca)
    let side = across(off, axis)
    if (len(side) < 1e-6) side = across(Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], axis)
    const to = add(add(ca, scale(axis, dot(off, axis))), scale(unit(side), distance))
    if (placed.has(b)) {
      if (Math.abs(len(across(off, axis)) - distance) > distance * 0.1)
        problems.push(`Gears ${named(a)} and ${named(b)} are each placed by other links and don't reach each other: link them in a chain, not a ring.`)
    } else shift(b, sub(to, cb))
    placed.add(a).add(b)
  }

  // ---- speeds: from each part that spins, through the links, to every part it drives
  interface Drive {
    speed: number
    phase: number
  }
  const drives = new Map<number, Drive>()
  const neighbours = (i: number) =>
    links.flatMap(l => (l.kind === 'mesh' || l.kind === 'belt' || l.kind === 'shaft') && l.ids.includes(i) ? [{ l, j: l.ids[0] === i ? l.ids[1] : l.ids[0] }] : [])

  /** How b turns, given how a turns and how they're joined. */
  function drive(kind: 'mesh' | 'belt' | 'shaft', a: number, b: number, d: Drive): Drive {
    const pa = parts[a], pb = parts[b]
    const along = dot(axisOf(pa), axisOf(pb))
    const sign = along < 0 ? -1 : 1
    if (kind === 'shaft') return { speed: d.speed * sign, phase: sign * d.phase }
    const gears = pa.shape === 'gear' && pb.shape === 'gear' // sprockets, on a chain
    const ratio = gears ? teethOf(pa) / teethOf(pb) : radiusOf(pa) / radiusOf(pb)
    if (kind === 'belt') return { speed: d.speed * sign * ratio, phase: pb.motion?.phase ?? 0 }
    const speed = -sign * d.speed * ratio
    if (!gears || Math.abs(along) < 0.9 || spinAxis(pa) !== 'y' || spinAxis(pb) !== 'y') return { speed, phase: 0 }
    // Teeth between teeth: where the line between the centres crosses a's teeth (as a fraction of a tooth past a
    // tooth's middle), b has a gap's middle the same fraction the other way round.
    const line = sub(centreOf(pb), centreOf(pa))
    const angle = (v: Vec, rot: number[] | undefined) => {
      const [x, , z] = unturn(v, rot)
      return Math.atan2(z, x)
    }
    const ta = (Math.PI * 2) / teethOf(pa), tb = (Math.PI * 2) / teethOf(pb)
    const fa = frac((angle(line, pa.rot) + d.phase * Math.PI * 2) / ta - TOOTH)
    const fb = frac(-sign * fa)
    const turnB = (fb + TOOTH + 0.5) * tb - angle(scale(line, -1), pb.rot)
    return { speed, phase: frac(turnB / (Math.PI * 2)) }
  }

  parts.forEach((p, i) => {
    if (p.motion?.kind !== 'spin' || drives.has(i)) return
    const group = [i]
    drives.set(i, { speed: p.motion.speed ?? 0.5, phase: p.motion.phase ?? 0 })
    for (let k = 0; k < group.length; k++) {
      const a = group[k]
      for (const { l, j } of neighbours(a)) {
        const d = drive(l.kind as 'mesh' | 'belt' | 'shaft', a, j, drives.get(a)!)
        const had = drives.get(j)
        if (!had) {
          drives.set(j, d)
          group.push(j)
        } else if (Math.abs(had.speed - d.speed) > 1e-6 * Math.max(1, Math.abs(d.speed)))
          problems.push(`${named(a)} and ${named(j)} are linked in a loop that would jam: they'd have to turn at two speeds at once.`)
      }
    }
    // A small gear on a big one can spin fast enough to flicker: slow the whole set together.
    const fastest = Math.max(...group.map(j => Math.abs(drives.get(j)!.speed)))
    const slow = fastest > FASTEST ? FASTEST / fastest : 1
    for (const j of group) {
      const d = drives.get(j)!
      const own = parts[j].motion
      parts[j].motion = { kind: 'spin', axis: own?.kind === 'spin' ? own.axis : spinAxis(parts[j]), speed: d.speed * slow, phase: d.phase }
    }
  })

  // ---- cranks
  const cranks: Crank[] = []
  for (const l of links) {
    if (l.kind !== 'crank') continue
    const [c, r, s] = l.ids
    const crank = parts[c]
    if (crank.motion?.kind !== 'spin') crank.motion = { kind: 'spin', axis: spinAxis(crank), speed: 0.5 }
    const axis = axisOf(crank)
    const centre = centreOf(crank)
    const off = sub(parts[s].at as Vec, centre)
    let u = across(off, axis)
    if (len(u) < 1e-6) u = across(Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], axis)
    const reach = len(u)
    u = unit(u)
    const throwBy = l.throw ?? radiusOf(crank) * 0.6
    let length = reach - throwBy
    if (length < throwBy * 1.5) {
      problems.push(`The ${named(s)} is too close to the ${named(c)} for a rod: put it at least 2.5 throws from the crank's centre.`)
      length = throwBy * 2.5
    }
    // Neither the rod nor the slider moves on its own: the crank moves them.
    parts[r].motion = parts[s].motion = undefined
    const offset = dot(off, axis)
    const face = spinAxis(crank) === 'y' ? thicknessOf(crank) / 2 : 0
    const rodHalf = thinnessOf(parts[r]) / 2
    const rodOffset = Math.abs(offset) < face + rodHalf ? (offset < 0 ? -1 : 1) * (face + rodHalf * 1.2) : offset
    cranks.push({ crank: c, rod: r, slider: s, centre, axis, u, offset, rodOffset, throw: throwBy, length })
    // A pin from the crank's face to the rod, turning with the crank, unless the figure has a part there already.
    const pin = add(add(centre, scale(u, throwBy)), scale(axis, rodOffset / 2))
    const taken = parts.some((p, i) => ![c, r, s].includes(i) && len(across(sub(centreOf(p), pin), axis)) < throwBy * 0.3)
    if (spinAxis(crank) === 'y' && !taken)
      parts.push({
        shape: 'cylinder',
        size: [rodHalf * 0.8, Math.abs(rodOffset) + rodHalf * 2],
        at: pin,
        rot: crank.rot,
        pivot: unturn(scale(u, -throwBy), crank.rot),
        material: 'steel',
        motion: { ...crank.motion! },
        id: `${named(c)} pin`,
      })
  }

  // ---- pipes with flow: beads run along them
  const runners: Runner[] = []
  parts.forEach((p, i) => {
    if (p.motion?.kind !== 'flow') return
    if (p.shape === 'pipe') runners.push({ part: i, speed: p.motion.speed ?? 0.5 })
    p.motion = undefined
  })

  const stretches = links.flatMap(l => (l.kind === 'stretch' ? [{ part: l.ids[0], to: l.ids[1] }] : []))
  for (const { part } of stretches) parts[part].motion = undefined

  // ---- belts: a loop round both pulleys, in the first one's plane
  for (const l of links) {
    if (l.kind !== 'belt') continue
    const [a, b] = l.ids
    const pa = parts[a], pb = parts[b]
    const axis = axisOf(pa)
    const ca = centreOf(pa)
    const thick = BELT * Math.min(radiusOf(pa), radiusOf(pb))
    const r1 = radiusOf(pa) + thick, r2 = radiusOf(pb) + thick
    const side = across(sub(centreOf(pb), ca), axis)
    const d = len(side)
    if (d <= Math.abs(r1 - r2) + 1e-3) {
      problems.push(`The belt can't go round ${named(a)} and ${named(b)}: one sits inside the other. Move them apart.`)
      continue
    }
    const e = unit(side), q = cross(axis, e)
    const at = (x: number, y: number): Vec => add(ca, add(scale(e, x), scale(q, y)))
    const g = Math.acos((r1 - r2) / d) // the tangent points' angle from the line between the centres
    const path: Vec[] = []
    const arc = (cx: number, r: number, from: number, to: number) => {
      const n = Math.max(4, Math.ceil(((to - from) / Math.PI) * 24))
      for (let k = 0; k <= n; k++) {
        const t = from + ((to - from) * k) / n
        path.push(at(cx + r * Math.cos(t), r * Math.sin(t)))
      }
    }
    // Straight runs get points along them too, so the smooth curve through the points stays straight.
    const run = (to: Vec) => {
      const from = path[path.length - 1]
      for (let k = 1; k < 6; k++) path.push(add(from, scale(sub(to, from), k / 6)))
    }
    arc(0, r1, g, Math.PI * 2 - g) // round the far side of a
    run(at(d + r2 * Math.cos(-g), r2 * Math.sin(-g)))
    arc(d, r2, -g, g) // round the far side of b
    run(path[0])
    path.push(path[0]) // closed
    const speed = parts[a].motion?.kind === 'spin' ? (parts[a].motion!.speed ?? 0.5) * Math.PI * 2 * r1 : 0
    runners.push({ part: parts.length, speed })
    parts.push({ shape: 'pipe', path, size: [thick], at: [0, 0, 0], material: 'rubber', id: `${named(a)}–${named(b)} belt` })
  }

  // ---- motions gravity times. Pendulum parts hung from one point (a rod and its bob) swing as one, at the pace of
  // the one that reaches furthest.
  const hung = new Map<string, Part[]>()
  for (const p of parts) {
    if (p.motion?.kind !== 'pendulum' || p.motion.speed !== undefined) continue
    const key = centreOf(p).map(v => v.toFixed(2)).join()
    hung.set(key, [...(hung.get(key) ?? []), p])
  }
  for (const group of hung.values()) {
    const length = Math.max(...group.map(p => len((p.pivot ?? [0, 0, 0]) as Vec) + radiusOf(p) * (p.pivot ? 0 : 1)))
    const swing = ((group[0].motion!.amount ?? 20) * Math.PI) / 180
    const speed = Math.sqrt(GRAVITY / length) / (Math.PI * 2) / (1 + (swing * swing) / 16)
    for (const p of group) p.motion = { ...p.motion!, speed, amount: group[0].motion!.amount, phase: group[0].motion!.phase }
  }
  for (const p of parts) if (p.motion?.kind === 'bounce' && p.motion.speed === undefined) p.motion.speed = 1 / (2 * Math.sqrt((2 * (p.motion.amount ?? 0.5)) / GRAVITY))

  return { parts, cranks, stretches, runners, problems: [...new Set(problems)] }
}

/** Where a crank puts its rod's ends (pin and end) and its slider at angle `turn` (radians), in the figure's frame. */
export function crankAt(c: Crank, turn: number): { pin: Vec; end: Vec; slider: Vec } {
  const w = cross(c.axis, c.u)
  const sin = Math.sin(turn), cos = Math.cos(turn)
  const pin = add(add(c.centre, scale(c.axis, c.rodOffset)), add(scale(c.u, c.throw * cos), scale(w, c.throw * sin)))
  const reach = c.throw * cos + Math.sqrt(Math.max(0, c.length * c.length - c.throw * c.throw * sin * sin))
  const slider = add(add(c.centre, scale(c.axis, c.offset)), scale(c.u, reach))
  return { pin, end: add(slider, scale(c.axis, c.rodOffset - c.offset)), slider }
}

