// Kept apart from marks.ts so the overlay page can use it without bundling zod.
import type { DrawPayload } from './marks'

/** Whether a drawing reads its caption out. */
export const speaksCaption = (p: Pick<DrawPayload, 'marks' | 'caption' | 'speakCaption'>): boolean =>
  !!p.caption && (p.speakCaption ?? !p.marks.some(m => m.say))
