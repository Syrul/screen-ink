// The drawing language: what an agent sends to `draw`. Coordinates are in the units of the last
// screenshot (x right, y down, origin top-left); the overlay maps them to screen points.
import { z } from 'zod'

const point = z.array(z.number()).length(2).describe('[x, y]')
const box = z.array(z.number()).length(4).describe('[x, y, width, height]')
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .optional()
  .describe('Hex colour like #FF5A36. Leave it out to use the ink colour.')
const delay = z.number().min(0).max(10).optional().describe('Extra seconds to wait before this mark starts.')
const side = z.enum(['above', 'below', 'left', 'right'])

export const markSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ring'), box, color, delay }).describe('A hand-drawn loop around a box.'),
  z
    .object({
      kind: z.literal('arrow'),
      from: point,
      to: point,
      bend: z.number().min(-1).max(1).optional().describe('Curve: 0 straight, ±1 strongly bent.'),
      color,
      delay,
    })
    .describe('An arrow whose tip touches `to`.'),
  z
    .object({
      kind: z.literal('label'),
      text: z.string().max(60),
      box: box.optional().describe('The thing being named; the pill sits beside it.'),
      at: point.optional().describe('Or a point the pill sits next to.'),
      side: side.optional().describe('Which side of the box or point. Default: above.'),
      color,
      delay,
    })
    .describe('A short name in a solid pill, placed beside a box or point, never on top of it.'),
  z
    .object({ kind: z.literal('badge'), at: point, n: z.union([z.number(), z.string().max(3)]), color, delay })
    .describe('A numbered step badge centred on `at`.'),
  z
    .object({ kind: z.literal('frame'), box, text: z.string().max(60).optional(), color, delay })
    .describe('A dashed frame with a faint tint around a region, with an optional title pill.'),
  z.object({ kind: z.literal('underline'), box, color, delay }).describe('A pen line under a box (usually text).'),
  z.object({ kind: z.literal('highlight'), box, color, delay }).describe('A translucent marker stroke over a box of text.'),
  z
    .object({
      kind: z.literal('text'),
      at: point.describe('Where the first line starts (top-left).'),
      text: z.string().max(200),
      size: z.number().min(8).max(64).optional().describe('Font size in points. Default 20.'),
      color,
      delay,
    })
    .describe('Free handwritten words on calm space.'),
  z
    .object({ kind: z.literal('line'), points: z.array(point).min(2).max(200), color, delay })
    .describe('A freehand pen line through the points.'),
  z.object({ kind: z.literal('spotlight'), box, delay }).describe('Dims everything except the box.'),
])

export const drawShape = {
  marks: z.array(markSchema).min(1).max(40).describe('Drawn in order, one after another.'),
  caption: z.string().max(400).optional().describe('One or two sentences shown at the bottom of the screen.'),
  append: z.boolean().optional().describe('Add to the current drawing instead of replacing it.'),
  fadeAfter: z.number().min(0).max(600).optional().describe('Seconds after drawing ends before it fades away. 0 or omitted: stays until cleared.'),
}

export type Mark = z.infer<typeof markSchema>
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
