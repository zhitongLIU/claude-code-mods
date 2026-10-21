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

// The new-side line numbers a unified patch shows: the added lines and the context around them. GitHub takes an inline
// review comment on these lines only, and refuses the whole review when one comment is anywhere else.
export function diffLines(patch: string): Set<number> {
  const out = new Set<number>()
  let at = 0
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (hunk) {
      at = Number(hunk[1])
    } else if (at > 0 && (row.startsWith('+') || row.startsWith(' ') || row === '')) {
      if (row !== '') out.add(at)
      at++
    }
  }
  return out
}

const rel = (file: string) => file.replace(/^\.\//, '').replace(/^\/+/, '')

// The findings that can be inline comments (their line is in the PR's diff) and the rest (no line, a line the diff does
// not show, or a file the PR does not change), which go in the review's own text instead.
export function splitByDiff(chosen: Finding[], patches: Record<string, string>) {
  const cache = new Map<string, Set<number>>()
  const inline: Finding[] = []
  const rest: Finding[] = []
  for (const f of chosen) {
    const path = rel(f.file)
    const patch = patches[path]
    if (f.line && patch !== undefined) {
      if (!cache.has(path)) cache.set(path, diffLines(patch))
      if (cache.get(path)?.has(f.line)) {
        inline.push(f)
        continue
      }
    }
    rest.push(f)
  }
  return { inline, rest }
}

// The body of POST /repos/{repo}/pulls/{n}/reviews, as one review of comments (nothing is approved or rejected).
// Inline findings sit on their line of the new side; the rest are listed in the review text, with their line as written.
export function reviewPayload(inline: Finding[], rest: Finding[], sha: string) {
  const n = inline.length + rest.length
  const where = (f: Finding) => `${rel(f.file)}${f.line ? `:${f.line}` : ''}`
  const body = [`${n} finding${n === 1 ? '' : 's'} from an AI review, approved by the reviewer.`, ...(rest.length ? ['', 'Not on a line of this diff:', ...rest.map(f => `- \`${where(f)}\` ${commentBody(f).replace(/\n+/g, ' ')}`)] : [])].join('\n')
  return {
    commit_id: sha,
    event: 'COMMENT',
    body,
    comments: inline.map(f => ({ path: rel(f.file), body: commentBody(f), line: f.line, side: 'RIGHT' })),
  }
}
