// Screenshots of one display, scaled to at most 1280 wide: the coordinate space the agent draws in. Each one also
// starts listing the elements on screen, from a sharper copy of the same image so small text still reads.
import { desktopCapturer, screen, systemPreferences, type Display } from 'electron'
import { hiddenWhile } from './overlay'
import { sense, type Element } from './sense'

const MAX_WIDTH = 1280
const SENSE_WIDTH = 2560

export interface Capture {
  display: Display
  width: number
  height: number
  /** Screen points per screenshot unit. */
  ppu: number
  jpeg: Buffer
  /** What is on screen, in screenshot units; empty when it can't be told. Never rejects. */
  elements: Promise<Element[]>
}

export function displayUnderCursor(): Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

export function screenAccess(): string {
  return process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
}

export async function capture(display: Display): Promise<Capture> {
  const { width: dw, height: dh } = display.size
  const sharp = Math.min(display.scaleFactor, SENSE_WIDTH / dw)
  const thumbnailSize = { width: Math.round(dw * sharp), height: Math.round(dh * sharp) }
  const sources = await hiddenWhile(() => desktopCapturer.getSources({ types: ['screen'], thumbnailSize }))
  const source = sources.find(s => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error(`No image for display ${display.id}. Screen Recording access: ${screenAccess()}.`)
  }
  const full = source.thumbnail
  const scale = Math.min(1, MAX_WIDTH / dw)
  const small = full.getSize().width > dw * scale ? full.resize({ width: Math.round(dw * scale), quality: 'best' }) : full
  const { width, height } = small.getSize()
  const ppu = dw / width
  const elements = sense(display, full.toJPEG(90), width, height, ppu).catch(() => [])
  return { display, width, height, ppu, jpeg: small.toJPEG(85), elements }
}
