import type { QaItem, QaSummary, Score } from '../types'

export type RubricItem = { id: string; title: string; category: 'core' | 'ui-ux' }

const SCORES: readonly Score[] = ['strong', 'acceptable', 'unacceptable']

export type Validated =
  | { ok: true; items: QaItem[]; overview: string; summary: QaSummary }
  | { ok: false; problems: string[] }

/** Checks a QA report's text against the rubric: every id scored once, every score one of three words, an overview. */
export function validateReport(text: string, rubric: readonly RubricItem[]): Validated {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, problems: [`not valid JSON: ${String(error)}`] }
  }
  const problems: string[] = []
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problems: ['the report must be a JSON object'] }
  }
  const obj = parsed as Record<string, unknown>
  const overview = typeof obj.overview === 'string' ? obj.overview.trim() : ''
  if (overview.length === 0) problems.push('"overview" must be a non-empty string')
  const rawItems = Array.isArray(obj.items) ? (obj.items as unknown[]) : null
  if (!rawItems) problems.push('"items" must be an array')
  const byId = new Map<string, QaItem>()
  for (const raw of rawItems ?? []) {
    if (typeof raw !== 'object' || raw === null) {
      problems.push('every item must be an object')
      continue
    }
    const it = raw as Record<string, unknown>
    const id = typeof it.id === 'string' ? it.id : ''
    const rubricItem = rubric.find(r => r.id === id)
    if (!rubricItem) {
      problems.push(`item id "${id}" is not in the rubric`)
      continue
    }
    if (byId.has(id)) {
      problems.push(`item "${id}" is scored twice`)
      continue
    }
    const score = it.score
    if (typeof score !== 'string' || !SCORES.includes(score as Score)) {
      problems.push(`item "${id}" has score ${JSON.stringify(score)}; use strong, acceptable or unacceptable`)
      continue
    }
    byId.set(id, {
      id,
      title: rubricItem.title,
      category: rubricItem.category,
      score: score as Score,
      note: typeof it.note === 'string' ? it.note.trim() : '',
    })
  }
  for (const r of rubric) if (!byId.has(r.id)) problems.push(`rubric item "${r.id}" (${r.title}) has no score`)
  if (problems.length > 0) return { ok: false, problems }
  const items = rubric.map(r => byId.get(r.id)!)
  return { ok: true, items, overview, summary: summarize(items) }
}

export function summarize(items: readonly QaItem[]): QaSummary {
  const strong = items.filter(i => i.score === 'strong').length
  const acceptable = items.filter(i => i.score === 'acceptable').length
  const unacceptable = items.filter(i => i.score === 'unacceptable').length
  const verdict = unacceptable > 0 ? 'fix' : acceptable > 0 ? 'pass-with-recommendations' : 'pass'
  return { strong, acceptable, unacceptable, verdict }
}

export function validateRubric(raw: unknown): { ok: true; rubric: RubricItem[] } | { ok: false; problem: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, problem: 'rubric must be a non-empty array' }
  const rubric: RubricItem[] = []
  const seen = new Set<string>()
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) return { ok: false, problem: 'every rubric item must be an object' }
    const it = item as Record<string, unknown>
    if (typeof it.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(it.id)) {
      return { ok: false, problem: `rubric item id ${JSON.stringify(it.id)} must be a kebab-case slug` }
    }
    if (seen.has(it.id)) return { ok: false, problem: `rubric item id "${it.id}" repeats` }
    seen.add(it.id)
    if (typeof it.title !== 'string' || it.title.trim().length === 0) {
      return { ok: false, problem: `rubric item "${it.id}" needs a title` }
    }
    if (it.category !== 'core' && it.category !== 'ui-ux') {
      return { ok: false, problem: `rubric item "${it.id}" category must be "core" or "ui-ux"` }
    }
    rubric.push({ id: it.id, title: it.title.trim(), category: it.category })
  }
  return { ok: true, rubric }
}
