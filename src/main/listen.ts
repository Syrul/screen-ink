// Hearing the question. The bar records while it is open and sends the audio here; Moonshine, an open 61M-parameter
// speech recognizer (MIT), turns it into text on the CPU through transformers.js, so nothing leaves the Mac. It
// takes well under a tenth of a second for a spoken question, quick enough to show the words as they are said.
import { app, ipcMain, systemPreferences } from 'electron'
import path from 'node:path'
import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { LISTEN } from './config'

const MODEL = 'onnx-community/moonshine-base-ONNX'
const SAMPLE_RATE = 16_000
const MAX_SECONDS = 30

let on = LISTEN
let asr: AutomaticSpeechRecognitionPipeline | null = null
let loading: Promise<void> | null = null

export const isOn = () => on

export function setOn(value: boolean): void {
  on = value
  if (on) void load()
}

/** Whether the bar should listen as it opens: on, and the recognizer is ready. */
export const ready = () => on && !!asr

/** Loads Moonshine, downloading it (about 65 MB) on first use. */
export function load(): Promise<void> {
  if (!on) return Promise.resolve()
  return (loading ??= (async () => {
    const { env, pipeline } = await import('@huggingface/transformers')
    env.cacheDir = path.join(app.getPath('userData'), 'models')
    const recognizer = await pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8', device: 'cpu' })
    await recognizer(new Float32Array(SAMPLE_RATE / 2)) // the first run is the slow one
    asr = recognizer
    console.log('screen-ink: listening with Moonshine')
  })().catch(e => {
    loading = null
    console.error(`screen-ink: the speech recognizer didn't load, so the bar only takes typing: ${(e as Error).message}`)
  }))
}

/** Asks macOS for the microphone the first time. False when it is off for screen-ink. */
export async function microphone(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return true
  if (status === 'not-determined') return systemPreferences.askForMediaAccess('microphone')
  return false
}

async function transcribe(samples: Float32Array): Promise<string> {
  if (!asr || !samples.length) return ''
  const out = await asr(samples.length > SAMPLE_RATE * MAX_SECONDS ? samples.subarray(0, SAMPLE_RATE * MAX_SECONDS) : samples)
  return (Array.isArray(out) ? out[0] : out).text.trim()
}

/** Lets `from` (the bar's page) send 16 kHz mono audio and get its words back. */
export function serve(from: () => Electron.WebContents | null): void {
  ipcMain.handle('ask:transcribe', (e, samples: unknown) =>
    e.sender === from() && samples instanceof Float32Array ? transcribe(samples) : '',
  )
}
