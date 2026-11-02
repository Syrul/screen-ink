// The pen's sounds: a soft scratch while a stroke is drawn and a tap as a pill or card lands. Made on the spot
// from filtered noise, quiet, and off unless the drawing says so.
let on = false
let ctx: AudioContext | null = null
let noise: AudioBuffer | null = null

export function setSounds(value: boolean): void {
  on = value
}

function audio(): AudioContext | null {
  if (!on) return null
  try {
    ctx ??= new AudioContext()
  } catch {
    return null
  }
  if (ctx.state === 'suspended') void ctx.resume()
  if (!noise) {
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const d = noise.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  return ctx
}

/** A pen scratching for `seconds`. */
export function scratch(seconds: number): void {
  const a = audio()
  if (!a || !noise) return
  const t = a.currentTime
  const src = a.createBufferSource()
  src.buffer = noise
  src.loop = true
  src.playbackRate.value = 0.8 + Math.random() * 0.4
  const band = a.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.setValueAtTime(2200 + Math.random() * 900, t)
  band.frequency.linearRampToValueAtTime(2600 + Math.random() * 900, t + seconds)
  band.Q.value = 0.8
  const gain = a.createGain()
  gain.gain.setValueAtTime(0, t)
  gain.gain.linearRampToValueAtTime(0.03, t + 0.03)
  // The nib's pressure wavers as it goes.
  for (let s = 0.08; s < seconds - 0.05; s += 0.07) gain.gain.linearRampToValueAtTime(0.018 + Math.random() * 0.016, t + s)
  gain.gain.linearRampToValueAtTime(0, t + seconds + 0.04)
  src.connect(band).connect(gain).connect(a.destination)
  src.start(t, Math.random() * 0.5)
  src.stop(t + seconds + 0.06)
}

/** A light tap, as something lands. */
export function tap(): void {
  const a = audio()
  if (!a || !noise) return
  const t = a.currentTime
  const src = a.createBufferSource()
  src.buffer = noise
  const band = a.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = 1500
  band.Q.value = 1.4
  const gain = a.createGain()
  gain.gain.setValueAtTime(0.06, t)
  gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.06)
  src.connect(band).connect(gain).connect(a.destination)
  src.start(t)
  src.stop(t + 0.08)
}
