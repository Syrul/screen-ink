// Photos for photo marks, fetched here so the overlay page never reaches the network. Only from the hosts in
// PHOTO_HOSTS (Wikimedia's by default): a photo's address is chosen by the model, which has seen the screen, so an
// open fetch could carry what is on screen to anyone. Only images, only so big, only so slow.
import { PHOTO_HOSTS } from './config'

const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] // no SVG: it can carry script
const MAX_BYTES = 6e6
const WAIT_MS = 6000

/** Why `url` can't be fetched, or null if it may be. */
export function refusal(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return `${url} isn't an address.`
  }
  if (u.protocol !== 'https:') return `${url} isn't https.`
  if (!PHOTO_HOSTS.includes(u.hostname)) return `photos come only from ${PHOTO_HOSTS.join(', ')}, not ${u.hostname}.`
  return null
}

/** Fetches the image at `url` as a data: URL. Throws, saying why, if it can't. */
export async function fetchPhoto(url: string): Promise<string> {
  const no = refusal(url)
  if (no) throw new Error(no)
  const res = await fetch(url, { signal: AbortSignal.timeout(WAIT_MS), redirect: 'follow', headers: { 'user-agent': 'screen-ink' } })
  const final = refusal(res.url)
  if (final) throw new Error(`it redirected: ${final}`)
  if (!res.ok) throw new Error(`${url} answered ${res.status}.`)
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!TYPES.includes(type)) throw new Error(`${url} isn't a photo (${type || 'no type'}).`)
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error(`${url} is too big.`)
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length
    if (size > MAX_BYTES) throw new Error(`${url} is too big.`)
    chunks.push(chunk)
  }
  return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`
}
