// Kept apart from marks.ts so the overlay page can use it without bundling zod.
import type { DrawPayload, Mark, MarkInput } from './marks'

/** Everything a mark says, in order: its own words, then a figure's steps'. */
export function words(m: Mark | MarkInput): string[] {
  const lines = [m.say, ...(m.kind === 'figure' ? (m.steps ?? []).map(s => s.say) : [])]
  return lines.filter((w): w is string => !!w?.trim())
}

/** Whether a drawing reads its caption out. By default it does when no mark has words of its own. */
export const speaksCaption = (p: Pick<DrawPayload, 'marks' | 'caption' | 'speakCaption'>): boolean =>
  !!p.caption && (p.speakCaption ?? !p.marks.some(m => words(m).length))
