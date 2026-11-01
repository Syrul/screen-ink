// The canvas: the last screenshot fixes the display and coordinate space that drawings use, whether they come
// from an MCP agent or from the shortcut.
import { screen, type Display } from 'electron'
import type { DrawPayload } from '../shared/marks'
import type { Capture } from './capture'
import { INK } from './config'
import * as overlay from './overlay'

let last: { displayId: number; width: number; height: number } | null = null

export function remember(shot: Capture): void {
  last = { displayId: shot.display.id, width: shot.width, height: shot.height }
}

export async function draw(args: Omit<DrawPayload, 'ppu' | 'ink'>): Promise<Display> {
  if (!last) throw new Error('Call screenshot first: draw uses its coordinates.')
  const d = screen.getAllDisplays().find(x => x.id === last!.displayId)
  if (!d) throw new Error('The display from the last screenshot is gone. Take a new screenshot.')
  await overlay.draw(d, { ...args, ppu: d.size.width / last.width, ink: INK })
  return d
}
