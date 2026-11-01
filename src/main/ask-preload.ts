// The prompt bar's bridge: questions and audio out, states and words in.
import { contextBridge, ipcRenderer } from 'electron'
import type { AskState } from './ask'

contextBridge.exposeInMainWorld('askBridge', {
  submit: (question: string) => ipcRenderer.send('ask:submit', question),
  cancel: () => ipcRenderer.send('ask:cancel'),
  startOver: () => ipcRenderer.send('ask:new'),
  transcribe: (samples: Float32Array): Promise<string> => ipcRenderer.invoke('ask:transcribe', samples),
  onState: (cb: (s: AskState) => void) => ipcRenderer.on('ask:state', (_e, s: AskState) => cb(s)),
})
