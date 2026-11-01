// The only bridge into the overlay page: drawings in, words out to be spoken and when they are, whether the mouse
// is over a card, questions about a figure's parts, and figures saved as 3D models.
import { contextBridge, ipcRenderer } from 'electron'
import type { DrawPayload } from '../shared/marks'

contextBridge.exposeInMainWorld('inkBridge', {
  onDraw: (cb: (p: DrawPayload) => void) => ipcRenderer.on('ink:draw', (_e, p: DrawPayload) => cb(p)),
  onClear: (cb: (o: { instant: boolean }) => void) => ipcRenderer.on('ink:clear', (_e, o: { instant: boolean }) => cb(o)),
  speak: (text: string): Promise<void> => ipcRenderer.invoke('ink:speak', text),
  pointer: (over: boolean) => ipcRenderer.send('ink:pointer', over),
  ask: (question: string) => ipcRenderer.send('ink:ask', question),
  save: (name: string, usdz: Uint8Array): Promise<string | null> => ipcRenderer.invoke('ink:save', name, usdz),
  onSaying: (cb: (s: { text: string; seconds: number }) => void) => ipcRenderer.on('ink:saying', (_e, s: { text: string; seconds: number }) => cb(s)),
})
