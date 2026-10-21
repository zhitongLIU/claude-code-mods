// Review findings from an AI review, shown pink on the code map and under their line in the diff drawer.
// Any review can feed them: the findings tool, `/mission findings <file>`, or the ReportFindings call of /code-review.
import type { Finding } from '../types'

const MAX_FINDINGS = 200
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

// Findings from whatever a review produced: an array, or an object holding one under `findings`.
// Rows without a file or a summary are dropped. `ReportFindings` field names are accepted as they are.
export function normalize(input: unknown): Finding[] {
  const rows = Array.isArray(input) ? input : input && typeof input === 'object' ? (input as { findings?: unknown }).findings : undefined
  if (!Array.isArray(rows)) return []
  return rows.flatMap((raw): Finding[] => {
    if (!raw || typeof raw !== 'object') return []
    const r = raw as Record<string, unknown>
    const file = text(r.file, 500)
    const summary = text(r.summary ?? r.short_summary, 400)
    if (!file || !summary) return []
    const line = typeof r.line === 'number' && Number.isInteger(r.line) && r.line > 0 ? r.line : undefined
    const scenario = text(r.scenario ?? r.failure_scenario, 1200)
    const severity = text(r.severity ?? r.category, 40)
    return [{ file, line, summary, scenario: scenario || undefined, severity: severity || undefined }]
  }).slice(0, MAX_FINDINGS)
}

// Findings from a file's text: JSON only, `[]` when it is anything else.
export function parseFindings(raw: string): Finding[] {
  try {
    return normalize(JSON.parse(raw))
  } catch {
    return []
  }
}

// The map path a finding's file is: the path itself, or the one ending in `/<file>` (findings give repo-relative paths,
// the map holds absolute ones). Several matches: the shortest, which is the closest to the repo root.
export function matchPath(file: string, mapPaths: string[]): string | undefined {
  const rel = file.replace(/^\.\//, '').replace(/^\/+/, '')
  const hits = mapPaths.filter(p => p === file || p.endsWith(`/${rel}`))
  return hits.sort((a, b) => a.length - b.length)[0]
}

// The findings grouped by the map path they belong to; the rest are counted apart.
export function byPath(findings: Finding[], mapPaths: string[]) {
  const matched: Record<string, Finding[]> = {}
  let unmatched = 0
  for (const f of findings) {
    const p = matchPath(f.file, mapPaths)
    if (p) (matched[p] ??= []).push(f)
    else unmatched++
  }
  return { matched, unmatched }
}

// A new set of findings on top of the old ones (`add`), or in place of them. The same file, line and summary counts once.
export function merge(old: Finding[], next: Finding[], add: boolean): Finding[] {
  if (!add) return next
  const key = (f: Finding) => `${f.file}:${f.line ?? ''}:${f.summary}`
  const seen = new Set(old.map(key))
  return [...old, ...next.filter(f => !seen.has(key(f)))].slice(0, MAX_FINDINGS)
}

// A pull request's repo and number from its link.
export function prRef(url: string | undefined) {
  const m = url ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url) : null
  return m ? { repo: m[1] as string, number: m[2] as string } : undefined
}

// One comment as GitHub shows it: the summary, then the concrete failure.
export function commentBody(f: Finding) {
  return `${f.severity ? `**${f.severity}** · ` : ''}${f.summary}${f.scenario ? `\n\n${f.scenario}` : ''}`
}

// The body of POST /repos/{repo}/pulls/{n}/reviews for the chosen findings, as one review of comments (nothing is approved
// or rejected). A finding with a line is an inline comment on the new side of the file; one without is a comment on the file.
export function reviewPayload(chosen: Finding[], sha: string) {
  return {
    commit_id: sha,
    event: 'COMMENT',
    body: `${chosen.length} finding${chosen.length === 1 ? '' : 's'} from an AI review, approved by the reviewer.`,
    comments: chosen.map(f => ({ path: f.file.replace(/^\.\//, '').replace(/^\/+/, ''), body: commentBody(f), ...(f.line ? { line: f.line, side: 'RIGHT' } : { subject_type: 'file' }) })),
  }
}
