// Narration. Kokoro, an open 82M-parameter voice model run on the CPU through kokoro-js, speaks each mark's words;
// macOS's `say` stands in until Kokoro has loaded, and for good with the voice set to say. The overlay asks for a
// mark's words as the mark starts and waits for them, so `speak` resolves once they are said (or cut off by a clear
// or a new drawing). `prepare` renders a drawing's lines ahead, in order, so each is ready when its mark starts.
// `speak` also says when the words start and how long they'll take, so the overlay can caption them.
import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, KokoroTTS } from 'kokoro-js'
import * as settings from './settings'

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
// The voice is chosen at launch. An unknown name fails Kokoro's warm-up below, which then leaves the speaking to say.
const VOICE = settings.get().voice
const MAC = VOICE === 'say' || VOICE.startsWith('say:')
const MAC_VOICE = VOICE.startsWith('say:') ? VOICE.slice(4) : null
const KOKORO_VOICE = (MAC ? 'af_heart' : VOICE) as NonNullable<GenerateOptions['voice']>
const on = () => settings.get().speak
let kokoro: KokoroTTS | null = null
let loading: Promise<void> | null = null
let current: ChildProcess | null = null
let turn = 0
let batch = 0
let queue: Promise<unknown> = Promise.resolve()
let clips = new Map<string, Promise<Clip | null>>()
let n = 0
interface Clip {
  file: string
  seconds: number
}

const SAY_WORDS_PER_SECOND = 2.9 // macOS's say at its default rate

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-ink-voice-'))
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))

export const isOn = on

export function setOn(value: boolean): void {
  settings.set({ speak: value })
  if (value) void load()
  else stop()
}

/** Loads Kokoro, downloading it (about 330 MB) on first use. */
export function load(): Promise<void> {
  if (MAC || !on()) return Promise.resolve()
  return (loading ??= (async () => {
    const { env } = await import('@huggingface/transformers')
    env.cacheDir = path.join(app.getPath('userData'), 'models')
    const { KokoroTTS } = await import('kokoro-js')
    const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'fp32', device: 'cpu' })
    await tts.generate('Ready.', { voice: KOKORO_VOICE }) // the first run is the slow one
    kokoro = tts
    console.log(`screen-ink: Kokoro is speaking (${KOKORO_VOICE})`)
  })().catch(e => console.error(`screen-ink: Kokoro didn't load, so say speaks instead: ${(e as Error).message}`)))
}

/** Renders `lines` in order, ahead of the marks that say them. Resolves when the first is ready. */
export function prepare(lines: string[]): Promise<unknown> {
  const tts = kokoro
  if (!on() || !tts) return Promise.resolve()
  const mine = batch
  for (const text of lines) {
    if (clips.has(text)) continue
    const clip = queue.then(() => (mine === batch ? render(tts, text) : null))
    clips.set(text, clip)
    queue = clip
  }
  return clips.get(lines[0]) ?? Promise.resolve()
}

async function render(tts: KokoroTTS, text: string): Promise<Clip | null> {
  try {
    const audio = await tts.generate(text, { voice: KOKORO_VOICE })
    const file = path.join(dir, `${++n}.wav`)
    await audio.save(file)
    return { file, seconds: audio.audio.length / audio.sampling_rate }
  } catch (e) {
    console.error(`screen-ink: Kokoro couldn't say "${text}": ${(e as Error).message}`)
    return null
  }
}

/** Says `text`, calling `onStart` with its length in seconds as the words begin. Resolves once they are said. */
export async function speak(text: string, onStart?: (seconds: number) => void): Promise<void> {
  stop()
  const mine = turn
  if (!on() || !text.trim()) return
  if (kokoro && !clips.has(text)) void prepare([text])
  const clip = (await clips.get(text)) ?? null
  clips.delete(text)
  if (mine !== turn) return
  onStart?.(clip?.seconds ?? text.split(/\s+/).length / SAY_WORDS_PER_SECOND)
  if (clip) {
    await play('afplay', [clip.file])
    fs.rm(clip.file, { force: true }, () => {})
  } else {
    // The words go in on stdin, so nothing in them can read as a flag.
    await play('say', [...(MAC_VOICE ? ['-v', MAC_VOICE] : []), '-f', '-'], text)
  }
}

function play(command: string, args: string[], input?: string): Promise<void> {
  return new Promise(resolve => {
    const child = (current = spawn(command, args))
    child.on('error', () => resolve())
    child.on('close', () => {
      if (current === child) current = null
      resolve()
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

export function stop(): void {
  turn++
  current?.kill()
  current = null
}

/** Drops lines rendered for a drawing that is gone. */
export function forget(): void {
  batch++
  clips = new Map()
}
