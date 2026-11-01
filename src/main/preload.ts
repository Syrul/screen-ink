// The only bridge into the overlay page: drawings in, nothing out.
import { contextBridge, ipcRenderer } from 'electron'
import type { DrawPayload } from '../shared/marks'

contextBridge.exposeInMainWorld('inkBridge', {
  onDraw: (cb: (p: DrawPayload) => void) => ipcRenderer.on('ink:draw', (_e, p: DrawPayload) => cb(p)),
  onClear: (cb: (o: { instant: boolean }) => void) => ipcRenderer.on('ink:clear', (_e, o: { instant: boolean }) => cb(o)),
})
