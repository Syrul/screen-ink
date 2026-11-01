// The prompt bar's bridge: questions out, states in.
import { contextBridge, ipcRenderer } from 'electron'
import type { AskState } from './ask'

contextBridge.exposeInMainWorld('askBridge', {
  submit: (question: string) => ipcRenderer.send('ask:submit', question),
  cancel: () => ipcRenderer.send('ask:cancel'),
  startOver: () => ipcRenderer.send('ask:new'),
  onState: (cb: (s: AskState) => void) => ipcRenderer.on('ask:state', (_e, s: AskState) => cb(s)),
})
