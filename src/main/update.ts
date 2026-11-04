// Telling the user a newer version is out. The app asks GitHub for the latest release (or reads a small JSON feed,
// {"version": "1.2.0", "url": "https://…"}, from SCREEN_INK_UPDATE_FEED) at launch and once a day, and the menu offers
// the download when there's something newer. Nothing is downloaded or installed by itself: that needs a signed app
// (Squirrel), which can come later. Development runs don't check.
import { app } from 'electron'

const RELEASES = 'https://api.github.com/repos/Syrul/screen-ink/releases/latest'
const FEED = process.env.SCREEN_INK_UPDATE_FEED || RELEASES
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
    const res = await fetch(FEED, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return
    const json = (await res.json()) as Partial<Update> & { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }
    if (json.draft || json.prerelease) return
    // A GitHub release names its version by tag (v1.2.0); a plain feed by version.
    const feed: Partial<Update> =
      typeof json.tag_name === 'string' ? { version: json.tag_name.replace(/^v/, ''), url: String(json.html_url ?? '') } : json
    if (typeof feed.version !== 'string' || typeof feed.url !== 'string' || !feed.url.startsWith('https://')) return
    if (!newer(feed.version, app.getVersion()) || found?.version === feed.version) return
    found = { version: feed.version, url: feed.url }
    onFound(found)
  } catch {} // offline, or no feed yet: try again tomorrow
}

/** Starts checking, in a packaged app or when a feed is set. */
export function watch(onFound: (u: Update) => void): void {
  if (!FEED.startsWith('https://') || (!app.isPackaged && !process.env.SCREEN_INK_UPDATE_FEED)) return
  void check(onFound)
  setInterval(() => void check(onFound), DAY_MS).unref()
}
