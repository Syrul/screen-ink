// Checks a figure before it is drawn: what its mechanism can't be made to do, and names that point at no part. The
// MCP draw tool reports these to the agent that drew it; in deep mode the shortcut asks Claude to fix them first.
import type { FigureMark, MarkInput } from './marks'
import { solve } from './mechanism'

type Figure = Pick<FigureMark, 'parts' | 'links' | 'labels' | 'steps'>

export function checkFigure(m: Figure): string[] {
  const problems = solve(m).problems
  const ids = new Set<string>()
  for (const p of m.parts) {
    if (!p.id) continue
    if (ids.has(p.id)) problems.push(`Two parts are called "${p.id}": give each its own id.`)
    ids.add(p.id)
  }
  const known = (id: string, where: string) => ids.has(id) || problems.push(`"${id}" (${where}) isn't a part's id.`)
  for (const l of m.labels ?? []) if (l.part) known(l.part, `the "${l.text}" label's part`)
  m.steps?.forEach((s, i) => {
    if (s.look && s.look !== 'all') known(s.look, `looked at in step ${i + 1}`)
    for (const id of s.focus ?? []) known(id, `focused on in step ${i + 1}`)
    for (const id of s.cut?.parts ?? []) known(id, `cut in step ${i + 1}`)
  })
  if (m.links?.some(l => l.kind === 'mesh' || l.kind === 'belt' || l.kind === 'shaft') && !m.parts.some(p => p.motion?.kind === 'spin'))
    problems.push('Nothing turns the linked parts: give the part that drives them a spin.')
  return [...new Set(problems)]
}

/** Problems in any of the figures among `marks`, each saying which figure. */
export function checkMarks(marks: MarkInput[]): string[] {
  const figures = marks.filter(m => m.kind === 'figure')
  return figures.flatMap(f => checkFigure(f).map(p => (figures.length > 1 ? `${f.title ?? 'A figure'}: ${p}` : p)))
}
