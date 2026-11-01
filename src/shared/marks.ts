// The drawing language: what an agent sends to `draw`. Coordinates are in the units of the last
// screenshot (x right, y down, origin top-left); the overlay maps them to screen points. A mark that points at
// something can name it by the id of an element the screenshot listed instead, and lands on it exactly.
import { z } from 'zod'

const point = z.array(z.number()).length(2).describe('[x, y]')
const box = z.array(z.number()).length(4).describe('[x, y, width, height]')
const element = z.string().regex(/^e\d+$/).describe("The id of an element from the screenshot's list, like e12")
const target = z.union([box, element]).describe('[x, y, width, height], or an element id (exact)')
const spot = z.union([point, element]).describe('[x, y], or an element id (exact)')
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .optional()
  .describe('Hex colour like #FF5A36. Leave it out to use the ink colour.')
const delay = z.number().min(0).max(10).optional().describe('Extra seconds to wait before this mark starts.')
const say = z
  .string()
  .max(300)
  .optional()
  .describe('Words spoken aloud as this mark starts to draw, when the user has voice on; the next mark waits until they are said. A sentence or two of plain speech.')
const side = z.enum(['above', 'below', 'left', 'right'])

// ---- 3D figures: parts in the figure's own units (y up); the camera frames the whole figure.
const vec3 = z.array(z.number()).length(3).describe('[x, y, z]')

const motionSchema = z
  .object({
    kind: z.enum(['spin', 'slide', 'swing']).describe('spin: turns round; slide: moves back and forth; swing: rocks back and forth.'),
    axis: z.enum(['x', 'y', 'z']).describe("In the part's own frame, after rot. Round shapes stand along y, so a wheel spins about y."),
    amount: z.number().optional().describe('slide: distance either way, in figure units; swing: degrees either way. Spin ignores it.'),
    speed: z
      .number()
      .min(-5)
      .max(5)
      .optional()
      .describe(
        'Cycles (turns) per second, negative reverses. Default 0.5. Linked wheels turn at speeds in inverse ratio of teeth (or radius): ' +
          'opposite signs when they mesh directly, the same sign when a chain or belt joins them.',
      ),
    phase: z.number().min(0).max(1).optional().describe('Head start as a fraction of a cycle, to keep linked parts in step.'),
  })
  .describe('How the part moves once the figure is built.')

const point2 = z.array(z.number()).length(2)

const copiesSchema = z
  .object({
    count: z.number().int().min(2).max(24).describe('How many in all, this part included.'),
    around: z.enum(['x', 'y', 'z']).optional().describe("Spread evenly round this axis through the figure's origin, like bolts on a flange or cylinders in a radial engine."),
    step: vec3.optional().describe('Or offset each copy from the last by this much, like teeth on a rack or links in a row.'),
    mirror: z.enum(['x', 'y', 'z']).optional().describe('Or one mirror image across this axis (count is then 2): a left and right wheel.'),
    phase: z.number().min(-1).max(1).optional().describe("Added to each copy's motion phase in turn, so copies move in sequence (a firing order)."),
  })
  .describe('Repeats the part, so a set of like parts is one entry.')

const partSchema = z.object({
  id: z.string().max(24).optional().describe('A name labels, steps and clicks refer to.'),
  shape: z.enum(['box', 'cylinder', 'tube', 'sphere', 'cone', 'torus', 'capsule', 'gear', 'spring', 'arrow', 'lathe', 'extrude', 'pipe']),
  size: z
    .array(z.number().positive())
    .min(1)
    .max(4)
    .optional()
    .describe(
      'box [width, height, depth]; cylinder [radius, height]; tube [outer radius, inner radius, height]; sphere [radius] or ' +
        '[x, y, z radii] for an egg or blob; cone [radius, height]; torus [ring radius, tube radius]; capsule [radius, length]; ' +
        'gear [radius, thickness, teeth]; spring [radius, length, coils, wire radius]; arrow [length, radius] (points up y); ' +
        'extrude [depth]; pipe [radius]; lathe takes none.',
    ),
  points: z
    .array(point2)
    .min(2)
    .max(64)
    .optional()
    .describe(
      'lathe: the profile as [radius, y] points from bottom to top, turned round the y axis (a bottle, a valve, a bolt, a bell). ' +
        'extrude: the outline as [x, y] points, given depth along z (a bracket, a cam, a lever, a letter).',
    ),
  path: z.array(vec3).min(2).max(64).optional().describe('pipe: the points it runs through, smoothly (a hose, a wire, a pipe run).'),
  at: vec3.describe('Where its centre sits (for lathe, extrude and pipe: where its own origin sits).'),
  rot: vec3.optional().describe('Rotation in degrees about x, y, z. Turn a wheel to face the camera with [90, 0, 0].'),
  pivot: vec3.optional().describe("The point, in the part's frame, that spin and swing turn around (a pendulum's top). Default: its centre."),
  color,
  material: z
    .enum(['matte', 'steel', 'brass', 'copper', 'glass', 'rubber', 'plastic'])
    .optional()
    .describe('What it is made of. matte (default) is a flat illustration; metals shine; glass shows what is inside; each has its own colour unless color is set.'),
  opacity: z.number().min(0.1).max(1).optional().describe('Below 1 lets you see inside (a housing over a piston).'),
  motion: motionSchema.optional(),
  copies: copiesSchema.optional(),
})

const stepSchema = z
  .object({
    say,
    view: z
      .object({
        yaw: z.number().optional(),
        pitch: z.number().optional(),
        zoom: z.number().min(0.5).max(5).optional().describe('1 as built, 2 twice as close.'),
      })
      .optional()
      .describe('Move the camera, smoothly.'),
    look: z.string().optional().describe("The id of a part to centre on (with zoom, to show it close up); 'all' for the whole figure again."),
    cut: z
      .object({
        axis: z.enum(['x', 'y', 'z', 'off']).describe("Slice along this axis and take away the half nearest the camera; 'off' closes it again."),
        at: z.number().optional().describe('Where along the axis, in figure units. Default: through the middle.'),
        parts: z.array(z.string()).optional().describe('Ids of the parts to cut, like the housing. Default: all.'),
      })
      .optional()
      .describe('A cutaway, to show what is inside.'),
    explode: z.number().min(0).max(1).optional().describe('Pull the parts out from the centre: 0 assembled, 1 well apart.'),
    focus: z.array(z.string()).optional().describe('Ids of parts to show plainly while the rest fade back; [] shows all again.'),
    motion: z.enum(['play', 'pause', 'slow']).optional().describe('Run the motion, stop it, or run it at a quarter speed.'),
    hold: z.number().min(0).max(10).optional().describe('Extra seconds to stay on this step.'),
  })
  .describe('One beat of the explanation after the figure is built: what is said, and what the figure does meanwhile. Each setting stays until a later step changes it.')

const figureLabelSchema = z.object({
  text: z.string().max(40),
  part: z.string().optional().describe('The id of the part it names; the label follows that part as it moves.'),
  at: vec3.optional().describe("The point it marks: in the part's frame when part is set, else the figure's. Default: the part's centre."),
})

export const markSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ring'), box: target, color, delay, say }).describe('A hand-drawn loop around a box.'),
  z
    .object({
      kind: z.literal('arrow'),
      from: spot,
      to: spot,
      bend: z.number().min(-1).max(1).optional().describe('Curve: 0 straight, ±1 strongly bent.'),
      color,
      delay,
      say,
    })
    .describe('An arrow whose tip touches `to`.'),
  z
    .object({
      kind: z.literal('label'),
      text: z.string().max(60),
      box: target.optional().describe('The thing being named; the pill sits beside it.'),
      at: point.optional().describe('Or a point the pill sits next to.'),
      side: side.optional().describe('Which side of the box or point. Default: above.'),
      color,
      delay,
      say,
    })
    .describe('A short name in a solid pill, placed beside a box or point, never on top of it.'),
  z
    .object({ kind: z.literal('badge'), at: spot, n: z.union([z.number(), z.string().max(3)]), color, delay, say })
    .describe('A numbered step badge centred on `at`.'),
  z
    .object({ kind: z.literal('frame'), box: target, text: z.string().max(60).optional(), color, delay, say })
    .describe('A dashed frame with a faint tint around a region, with an optional title pill.'),
  z.object({ kind: z.literal('underline'), box: target, color, delay, say }).describe('A pen line under a box (usually text).'),
  z.object({ kind: z.literal('highlight'), box: target, color, delay, say }).describe('A translucent marker stroke over a box of text.'),
  z
    .object({
      kind: z.literal('text'),
      at: point.describe('Where the first line starts (top-left).'),
      text: z.string().max(200),
      size: z.number().min(8).max(64).optional().describe('Font size in points. Default 20.'),
      color,
      delay,
      say,
    })
    .describe('Free handwritten words on calm space.'),
  z
    .object({ kind: z.literal('line'), points: z.array(point).min(2).max(200), color, delay, say })
    .describe('A freehand pen line through the points.'),
  z.object({ kind: z.literal('spotlight'), box: target, delay, say }).describe('Dims everything except the box.'),
  z
    .object({
      kind: z.literal('figure'),
      box: box.describe("Where the figure's card stands: calm space, at least about 320×260."),
      title: z.string().max(60).optional(),
      parts: z.array(partSchema).min(1).max(40).describe('Built in this order, one by one.'),
      labels: z.array(figureLabelSchema).max(8).optional(),
      view: z
        .object({ yaw: z.number().optional(), pitch: z.number().optional() })
        .optional()
        .describe('Camera angle in degrees around and above the figure. Default yaw 30, pitch 20.'),
      turntable: z.boolean().optional().describe('Slowly turn the whole figure so its depth reads.'),
      steps: z
        .array(stepSchema)
        .max(8)
        .optional()
        .describe('After the build, walk through how it works: cut it open, pull it apart, show one part close up, slow the motion, each with its own words.'),
      color: color.describe('Colour of the label pills. Parts take their own colours.'),
      delay,
      say,
    })
    .describe(
      'A small 3D model on a card for explaining how something works or is built: parts appear one by one, labels follow them, ' +
        'motion shows how it moves, and steps walk through it. The user can turn it by dragging and click a part to ask about it.',
    ),
])

export const drawShape = {
  marks: z.array(markSchema).min(1).max(40).describe('Drawn in order, one after another.'),
  caption: z.string().max(400).optional().describe('One or two sentences shown at the bottom of the screen.'),
  append: z.boolean().optional().describe('Add to the current drawing instead of replacing it.'),
  fadeAfter: z.number().min(0).max(600).optional().describe('Seconds after drawing ends before it fades away. 0 or omitted: stays until cleared.'),
}

/** A mark as sent, which may name elements. */
export type MarkInput = z.infer<typeof markSchema>
type Placed<M> = M extends unknown ? { [K in keyof M]: K extends 'box' | 'at' | 'from' | 'to' ? Exclude<M[K], string> : M[K] } : never
/** A mark with its element ids replaced by coordinates, as the overlay draws it. */
export type Mark = Placed<MarkInput>
export type FigureMark = Extract<Mark, { kind: 'figure' }>
export type Point = [number, number]
export type Box = [number, number, number, number]

/** What the main process sends the overlay. `ppu` is screen points per drawing unit. */
export interface DrawPayload {
  marks: Mark[]
  caption?: string
  append?: boolean
  fadeAfter?: number
  /** Whether to read the caption out. By default it is read when no mark has words of its own. */
  speakCaption?: boolean
  ppu: number
  ink: string
}
