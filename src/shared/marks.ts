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

const partSchema = z.object({
  id: z.string().max(24).optional().describe('A name labels can attach to.'),
  shape: z.enum(['box', 'cylinder', 'tube', 'sphere', 'cone', 'torus', 'capsule', 'gear', 'spring', 'arrow']),
  size: z
    .array(z.number().positive())
    .min(1)
    .max(4)
    .describe(
      'box [width, height, depth]; cylinder [radius, height]; tube [outer radius, inner radius, height]; sphere [radius]; ' +
        'cone [radius, height]; torus [ring radius, tube radius]; capsule [radius, length]; gear [radius, thickness, teeth]; ' +
        'spring [radius, length, coils, wire radius]; arrow [length, radius] (points up y).',
    ),
  at: vec3.describe('Where its centre sits.'),
  rot: vec3.optional().describe('Rotation in degrees about x, y, z. Turn a wheel to face the camera with [90, 0, 0].'),
  pivot: vec3.optional().describe("The point, in the part's frame, that spin and swing turn around (a pendulum's top). Default: its centre."),
  color,
  opacity: z.number().min(0.1).max(1).optional().describe('Below 1 lets you see inside (a housing over a piston).'),
  motion: motionSchema.optional(),
})

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
      color: color.describe('Colour of the label pills. Parts take their own colours.'),
      delay,
      say,
    })
    .describe('A small 3D model on a card for explaining how something works or is built: parts appear one by one, labels follow them, and motion shows how it moves.'),
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
  ppu: number
  ink: string
}
