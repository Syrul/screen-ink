// The canvas: the last screenshot fixes the display, coordinate space and element list that drawings use, whether
// they come from an MCP agent or from the shortcut.
import { screen, type Display } from 'electron'
import type { DrawPayload, Mark, MarkInput } from '../shared/marks'
import { displayUnderCursor, type Capture } from './capture'
import * as lessons from './lessons'
import * as overlay from './overlay'
import { fetchPhoto } from './photos'
import { place, type Element } from './sense'
import * as settings from './settings'

let last: { displayId: number; width: number; elements: Promise<Element[]> } | null = null

export function remember(shot: Capture): void {
  last = { displayId: shot.display.id, width: shot.width, elements: shot.elements }
}

export type Drawing = Omit<DrawPayload, 'ppu' | 'ink' | 'marks'> & { marks: MarkInput[] }

/**
 * Draws on the last screenshot's display. `missing` lists element ids the screenshot didn't have; their marks are left
 * out, as are photos that couldn't be fetched (`failed` says why).
 */
export async function draw(args: Drawing): Promise<{ display: Display; drawn: number; missing: string[]; failed: string[] }> {
  if (!last) throw new Error('Call screenshot first: draw uses its coordinates.')
  const d = screen.getAllDisplays().find(x => x.id === last!.displayId)
  if (!d) throw new Error('The display from the last screenshot is gone. Take a new screenshot.')
  const ppu = d.size.width / last.width
  const { marks: placed, missing } = place(args.marks, await last.elements, ppu)
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
