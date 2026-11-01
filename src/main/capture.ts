// Screenshots of one display, scaled to at most 1280 wide: the coordinate space the agent draws in.
import { desktopCapturer, screen, systemPreferences, type Display } from 'electron'
import { hiddenWhile } from './overlay'

const MAX_WIDTH = 1280

export interface Capture {
  display: Display
  width: number
  height: number
  /** Screen points per screenshot unit. */
  ppu: number
  jpeg: Buffer
}

export function displayUnderCursor(): Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

export function screenAccess(): string {
  return process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
}

export async function capture(display: Display): Promise<Capture> {
  const { width: dw, height: dh } = display.size
  const scale = Math.min(1, MAX_WIDTH / dw)
  const thumbnailSize = { width: Math.round(dw * scale), height: Math.round(dh * scale) }
  const sources = await hiddenWhile(() => desktopCapturer.getSources({ types: ['screen'], thumbnailSize }))
  const source = sources.find(s => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error(`No image for display ${display.id}. Screen Recording access: ${screenAccess()}.`)
  }
  const { width, height } = source.thumbnail.getSize()
  return { display, width, height, ppu: dw / width, jpeg: source.thumbnail.toJPEG(85) }
}
