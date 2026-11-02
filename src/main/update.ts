// Telling the user a newer version is out. The app checks a small JSON feed, {"version": "1.2.0", "url": "https://…"},
// at launch and once a day, and the menu offers the download when there's something newer. Nothing is downloaded or
// installed by itself: that needs a signed app (Squirrel), which can come later. No feed configured, no check.
import { app } from 'electron'

const FEED = process.env.SCREEN_INK_UPDATE_FEED || '' // set at build time for a release
const DAY_MS = 24 * 60 * 60 * 1000

export interface Update {
  version: string
  url: string
}

let found: Update | null = null
export const available = () => found

/** a > b, for versions like 1.2.10. */
export function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(n => parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

async function check(onFound: (u: Update) => void): Promise<void> {
  try {
    const res = await fetch(FEED, { signal: AbortSignal.timeout(10_000) })
    const feed = (await res.json()) as Partial<Update>
    if (typeof feed.version !== 'string' || typeof feed.url !== 'string' || !feed.url.startsWith('https://')) return
    if (!newer(feed.version, app.getVersion()) || found?.version === feed.version) return
    found = { version: feed.version, url: feed.url }
    onFound(found)
  } catch {} // offline, or no feed yet: try again tomorrow
}

/** Starts checking, if there is a feed. */
export function watch(onFound: (u: Update) => void): void {
  if (!FEED.startsWith('https://')) return
  void check(onFound)
  setInterval(() => void check(onFound), DAY_MS).unref()
}
