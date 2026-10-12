// Feeds the diff drawer to highlight.js. Runs in the page too (template.ts splices the source in), so these
// two functions may call only each other.
import type { DiffLine } from './diff'

// The highlight.js language for a file extension, or '' when there is none (the drawer then uses highlight.ts).
export function langOf(ext: string): string {
  const by: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', php: 'php', cs: 'csharp',
    c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
    css: 'css', scss: 'scss', html: 'xml', vue: 'xml', svelte: 'xml', xml: 'xml',
    json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', lua: 'lua', md: 'markdown', mdx: 'markdown',
  }
  return by[ext.toLowerCase()] ?? ''
}

// One piece of HTML per row (undefined where it could not be made). A diff shows hunks, so each hunk is
// highlighted twice as a block, as the new file reads there (context and added lines) and as the old file read
// (context and deleted lines): a string or comment that runs over several lines stays whole inside a hunk.
export function htmlRows(rows: DiffLine[], lang: string, hljs: { highlight: (code: string, o: { language: string; ignoreIllegals: boolean }) => { value: string } }): (string | undefined)[] {
  const out: (string | undefined)[] = new Array(rows.length).fill(undefined)
  try {
    let from = 0
    for (let to = 0; to <= rows.length; to++) {
      if (to < rows.length && (rows[to] as DiffLine).k !== 'h') continue
      const seg = rows.slice(from, to).map((r, i) => ({ r, at: from + i }))
      from = to + 1
      for (const side of ['new', 'old'] as const) {
        const mine = seg.filter(({ r }) => (side === 'new' ? r.k !== 'd' : r.k === 'd' || r.k === 'c'))
        if (!mine.length) continue
        const html = hljs.highlight(mine.map(({ r }) => r.t).join('\n'), { language: lang, ignoreIllegals: true }).value
        // The block's HTML cut at its newlines; a span open at a cut is closed there and reopened on the next line.
        const open: string[] = []
        const lines: string[] = ['']
        for (const part of html.split(/(<[^>]+>)/)) {
          if (!part) continue
          if (part[0] === '<') {
            if (part[1] === '/') open.pop()
            else open.push(part)
            lines[lines.length - 1] += part
          } else {
            part.split('\n').forEach((piece, i) => {
              if (i > 0) {
                lines[lines.length - 1] += '</span>'.repeat(open.length)
                lines.push(open.join(''))
              }
              lines[lines.length - 1] += piece
            })
          }
        }
        mine.forEach(({ r, at }, i) => {
          if (side === 'new' || r.k === 'd') out[at] = lines[i]
        })
      }
    }
  } catch {
    return new Array(rows.length).fill(undefined)
  }
  return out
}
