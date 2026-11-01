// The canvas: the last screenshot fixes the display, coordinate space and element list that drawings use, whether
// they come from an MCP agent or from the shortcut.
import { screen, type Display } from 'electron'
import type { DrawPayload, MarkInput } from '../shared/marks'
import type { Capture } from './capture'
import { INK } from './config'
import * as overlay from './overlay'
import { place, type Element } from './sense'

let last: { displayId: number; width: number; elements: Promise<Element[]> } | null = null

export function remember(shot: Capture): void {
  last = { displayId: shot.display.id, width: shot.width, elements: shot.elements }
}

type Drawing = Omit<DrawPayload, 'ppu' | 'ink' | 'marks'> & { marks: MarkInput[] }

/** Draws on the last screenshot's display. `missing` lists element ids the screenshot didn't have; their marks are left out. */
export async function draw(args: Drawing): Promise<{ display: Display; drawn: number; missing: string[] }> {
  if (!last) throw new Error('Call screenshot first: draw uses its coordinates.')
  const d = screen.getAllDisplays().find(x => x.id === last!.displayId)
  if (!d) throw new Error('The display from the last screenshot is gone. Take a new screenshot.')
  const ppu = d.size.width / last.width
  const { marks, missing } = place(args.marks, await last.elements, ppu)
  if (!marks.length) throw new Error(`The last screenshot has no element ${missing.join(', ')}. Take a new screenshot and use its ids.`)
  await overlay.draw(d, { ...args, marks, ppu, ink: INK })
  return { display: d, drawn: marks.length, missing }
}
