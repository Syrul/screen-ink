// Offline licence keys. A key is the buyer's name and email, signed with the seller's Ed25519 private key and checked
// here with the public key: no server, no network, no expiry. `node scripts/licence.mjs` makes the key pair and
// signs keys. Nothing is locked without a key yet; the app just says whose copy it is.
import { app } from 'electron'
import crypto from 'node:crypto'

// The public half of the seller's key pair, from `node scripts/licence.mjs keygen`. Empty until there is one; a
// development run may use SCREEN_INK_LICENCE_PUBLIC_KEY instead, a packaged app never does.
const PUBLIC_KEY = ''
const PREFIX = 'SI1' // the key format's version

export interface Licence {
  name: string
  email: string
  /** When it was issued, as an ISO date. */
  issued: string
  edition: string
}

export type LicenceState = { state: 'licensed'; licence: Licence } | { state: 'unlicensed' } | { state: 'invalid' } | { state: 'no-public-key' }

function publicKey(): crypto.KeyObject | null {
  const pem = PUBLIC_KEY || (app.isPackaged ? '' : (process.env.SCREEN_INK_LICENCE_PUBLIC_KEY ?? '').replace(/\\n/g, '\n'))
  if (!pem) return null
  try {
    return crypto.createPublicKey(pem)
  } catch {
    return null
  }
}

/** The licence a key carries, or null if it isn't one this app's seller signed. */
export function verify(key: string, pub = publicKey()): Licence | null {
  if (!pub) return null
  const [prefix, body, signature] = key.replace(/\s+/g, '').split('.')
  if (prefix !== PREFIX || !body || !signature) return null
  try {
    if (!crypto.verify(null, Buffer.from(`${PREFIX}.${body}`), pub, Buffer.from(signature, 'base64url'))) return null
    const l = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof l.name !== 'string' || typeof l.email !== 'string') return null
    return { name: l.name, email: l.email, issued: String(l.issued ?? ''), edition: String(l.edition ?? 'personal') }
  } catch {
    return null
  }
}

/** What the saved key (if any) says. */
export function state(key: string): LicenceState {
  const pub = publicKey()
  if (!pub) return { state: 'no-public-key' }
  if (!key.trim()) return { state: 'unlicensed' }
  const licence = verify(key, pub)
  return licence ? { state: 'licensed', licence } : { state: 'invalid' }
}
