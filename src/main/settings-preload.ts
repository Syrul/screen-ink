// The Settings window's bridge: it reads the settings and their status, and asks for changes.
import { contextBridge, ipcRenderer } from 'electron'
import type { Settings } from './settings'
import type { View } from './settings-window'
import type { LicenceState } from './licence'

contextBridge.exposeInMainWorld('settingsBridge', {
  view: (): Promise<View> => ipcRenderer.invoke('settings:view'),
  set: (patch: Partial<Settings>): Promise<{ ok: boolean; message?: string; restart?: boolean }> => ipcRenderer.invoke('settings:set', patch),
  setKey: (key: string | null): Promise<boolean> => ipcRenderer.invoke('settings:key', key),
  setLicence: (key: string): Promise<LicenceState | null> => ipcRenderer.invoke('settings:licence', key),
  grant: (what: 'screen' | 'accessibility' | 'microphone'): Promise<void> => ipcRenderer.invoke('settings:grant', what),
  copy: (text: string): Promise<void> => ipcRenderer.invoke('settings:copy', text),
  link: (url: string): Promise<void> => ipcRenderer.invoke('settings:link', url),
  relaunch: (): Promise<void> => ipcRenderer.invoke('settings:relaunch'),
})
