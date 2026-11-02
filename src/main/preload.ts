// The only bridge into the overlay page: drawings in, words out to be spoken and when they are, whether the mouse
// is over a card, questions about a figure's parts, figures saved as 3D models, the buttons the user clicks, where
// screen-ink's own pointer goes and presses, and the build panel's steps in and its buttons out.
import { contextBridge, ipcRenderer } from 'electron'
import type { BuildPanel } from '../shared/build'
import type { DrawPayload } from '../shared/marks'

type Point = { id: number; at: [number, number]; press?: boolean; label?: string; scroll?: 'down' | 'up' | 'right' | 'left' }

contextBridge.exposeInMainWorld('inkBridge', {
  onDraw: (cb: (p: DrawPayload) => void) => ipcRenderer.on('ink:draw', (_e, p: DrawPayload) => cb(p)),
  onClear: (cb: (o: { instant: boolean }) => void) => ipcRenderer.on('ink:clear', (_e, o: { instant: boolean }) => cb(o)),
  speak: (text: string): Promise<void> => ipcRenderer.invoke('ink:speak', text),
  pointer: (over: boolean) => ipcRenderer.send('ink:pointer', over),
  ask: (question: string) => ipcRenderer.send('ink:ask', question),
  save: (name: string, usdz: Uint8Array): Promise<string | null> => ipcRenderer.invoke('ink:save', name, usdz),
  act: (what: string, value: string, folder?: string): Promise<'done' | 'copied' | null> => ipcRenderer.invoke('ink:act', what, value, folder),
  onPoint: (cb: (p: Point) => void) => ipcRenderer.on('ink:point', (_e, p: Point) => cb(p)),
  pointed: (id: number) => ipcRenderer.send('ink:pointed', id),
  onSaying: (cb: (s: { text: string; seconds: number }) => void) => ipcRenderer.on('ink:saying', (_e, s: { text: string; seconds: number }) => cb(s)),
  onBuild: (cb: (p: BuildPanel | null) => void) => ipcRenderer.on('ink:build', (_e, p: BuildPanel | null) => cb(p)),
  buildGo: (move: string) => ipcRenderer.send('ink:build-go', move),
  buildSay: (text: string): Promise<void> => ipcRenderer.invoke('ink:build-say', text),
})
