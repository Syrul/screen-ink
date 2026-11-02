// The canvas: the last screenshot fixes the display, coordinate space and element list that drawings use, whether
// they come from an MCP agent or from the shortcut.
import { screen, type Display } from 'electron'
import type { Box, DrawPayload, Mark, MarkInput, Point } from '../shared/marks'
import { displayUnderCursor, type Capture } from './capture'
import * as lessons from './lessons'
import * as overlay from './overlay'
import { fetchPhoto } from './photos'
import { place, type Element } from './sense'
import * as settings from './settings'

let last: { displayId: number; width: number; height: number; elements: Promise<Element[]> } | null = null

export function remember(shot: Capture): void {
  last = { displayId: shot.display.id, width: shot.width, height: shot.height, elements: shot.elements }
}

/** The last screenshot's display, and its size in units, or why there is none. */
function lastDisplay(): { d: Display; width: number; height: number; ppu: number } {
  if (!last) throw new Error('Call screenshot first: it fixes the coordinates.')
  const d = screen.getAllDisplays().find(x => x.id === last!.displayId)
  if (!d) throw new Error('The display from the last screenshot is gone. Take a new screenshot.')
  return { d, width: last.width, height: last.height, ppu: d.size.width / last.width }
}

/**
 * The middle of `at` (a box in the last screenshot's units, or one of its element ids), or of the screen, in global
 * points; with the display and its points per unit.
 */
export async function spot(at?: Box | string): Promise<{ display: Display; point: Point; ppu: number; size: [number, number] }> {
  const { d, width, height, ppu } = lastDisplay()
  const box = at === undefined ? ([0, 0, width, height] as Box) : typeof at === 'string' ? (await last!.elements).find(e => e.id === at)?.box : at
  if (!box) throw new Error(`The last screenshot has no element ${at}. Take a new screenshot and use its ids.`)
  return { display: d, point: [d.bounds.x + (box[0] + box[2] / 2) * ppu, d.bounds.y + (box[1] + box[3] / 2) * ppu], ppu, size: [width, height] }
}

export type Drawing = Omit<DrawPayload, 'ppu' | 'ink' | 'marks'> & { marks: MarkInput[] }

/**
 * Draws on the last screenshot's display. `missing` lists element ids the screenshot didn't have; their marks are left
 * out, as are photos that couldn't be fetched (`failed` says why).
 */
export async function draw(args: Drawing): Promise<{ display: Display; drawn: number; missing: string[]; failed: string[] }> {
  const { d, ppu } = lastDisplay()
  const { marks: placed, missing } = place(args.marks, await last!.elements, ppu)
  if (args.marks.length && !placed.length) throw new Error(`The last screenshot has no element ${missing.join(', ')}. Take a new screenshot and use its ids.`)
  const failed: string[] = []
  const marks = (
    await Promise.all(
      placed.map(async m => {
        if (m.kind !== 'photo') return m
        try {
          return { ...m, url: await fetchPhoto(m.url) }
        } catch (e) {
          failed.push(`couldn't show the photo, ${(e as Error).message}`)
          return null
        }
      }),
    )
  ).filter(m => m !== null)
  await overlay.draw(d, { ...args, marks, ppu, ink: settings.get().ink })
  return { display: d, drawn: marks.length, missing, failed }
}

/** Where a drawing that needs no screenshot goes: where the ink is now, else under the mouse. */
const here = () => overlay.showing() ?? displayUnderCursor()

/** Adds marks that place themselves (no boxes or element ids, like a card in the corner) to the drawing. */
export async function add(marks: Mark[], fadeAfter?: number): Promise<Display> {
  const d = here()
  await overlay.draw(d, { marks, append: true, fadeAfter, ppu: 1, ink: settings.get().ink })
  return d
}

/** Draws a saved lesson again. Resolves whether there was one by that id. */
export async function showLesson(id: string): Promise<boolean> {
  const d = here()
  const drawings = lessons.drawings(id, d)
  if (!drawings) return false
  for (const p of drawings) await overlay.draw(d, { ...p, ink: settings.get().ink })
  return true
}
