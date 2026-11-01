// Records a spoken question at 16 kHz, the rate the recognizer takes, and tells when the speaker has finished.
// Speech is whatever is well above the room's own level, measured in the first moments; a pause after it ends the
// question.
const RATE = 16_000
const FRAME = 1024 // samples per check, 64 ms
const ROOM_FRAMES = 6 // the first frames, whose quietest sets the room's level
const LEAD_MS = 300 // audio kept from just before the speech starts
const PAUSE_MS = 1000 // a pause this long after speech ends the question
const NOTHING_MS = 7000 // nothing said this long: stop listening
const MAX_MS = 30_000

export type End = 'pause' | 'nothing' | 'max'

export interface MicEvents {
  /** How loud it is, 0 to 1, every frame. */
  level(v: number): void
  /** Speech has started. */
  speech(): void
  end(why: End): void
}

export class Mic {
  private frames: Float32Array[] = []
  private room = Infinity
  private started = -1 // the frame speech started at
  private lastLoud = 0
  private loudRun = 0
  private stopped = false

  private constructor(
    private ctx: AudioContext,
    private stream: MediaStream,
    private node: ScriptProcessorNode,
    private on: MicEvents,
  ) {}

  static async open(on: MicEvents): Promise<Mic> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    const ctx = new AudioContext({ sampleRate: RATE })
    const source = ctx.createMediaStreamSource(stream)
    const node = ctx.createScriptProcessor(FRAME, 1, 1)
    const mic = new Mic(ctx, stream, node, on)
    node.onaudioprocess = e => mic.frame(new Float32Array(e.inputBuffer.getChannelData(0)))
    source.connect(node)
    node.connect(ctx.destination) // a script processor only runs when connected; it outputs silence
    return mic
  }

  get speaking(): boolean {
    return this.started >= 0
  }

  /** The question so far, from just before the speech started. */
  samples(): Float32Array {
    const from = Math.max(0, this.started - Math.ceil((LEAD_MS * RATE) / 1000 / FRAME))
    const frames = this.started < 0 ? [] : this.frames.slice(from)
    const out = new Float32Array(frames.length * FRAME)
    frames.forEach((f, i) => out.set(f, i * FRAME))
    return out
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.node.disconnect()
    this.stream.getTracks().forEach(t => t.stop())
    void this.ctx.close()
  }

  private frame(f: Float32Array): void {
    if (this.stopped) return
    const n = this.frames.push(f)
    let sum = 0
    for (const v of f) sum += v * v
    const rms = Math.sqrt(sum / f.length)
    this.on.level(Math.min(1, rms * 6))
    if (n <= ROOM_FRAMES) {
      this.room = Math.min(this.room, rms)
      return
    }
    const loud = rms > Math.max(0.012, Math.min(this.room, 0.03) * 2.5)
    const ms = (frames: number) => (frames * FRAME * 1000) / RATE
    // Two loud frames in a row are speech; one is a click or a bump.
    this.loudRun = loud ? this.loudRun + 1 : 0
    if (loud) this.lastLoud = n
    if (this.started < 0 && this.loudRun >= 2) {
      this.started = n - 2
      this.on.speech()
    }
    const why: End | null =
      this.started >= 0 && ms(n - this.lastLoud) > PAUSE_MS ? 'pause' : this.started < 0 && ms(n) > NOTHING_MS ? 'nothing' : ms(n) > MAX_MS ? 'max' : null
    if (why) {
      this.stop()
      this.on.end(why)
    }
  }
}
