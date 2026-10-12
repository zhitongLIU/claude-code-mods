// The diff drawer's logic. parseDiff, formatComment and formatReview run in the page too: template.ts
// splices their source into its script, so they may call only each other.

// One row of a diff: a hunk header (h), unchanged (c), added (a) or deleted (d) line, with its numbers.
export type DiffLine = { k: 'h' | 'c' | 'a' | 'd'; o?: number; n?: number; t: string }
export type ReviewComment = { path: string; lines: DiffLine[]; text: string }

// A unified diff of one file, with or without its file headers (a GitHub patch has none). Rows are counted off
// each hunk's header, so a deleted line that reads "-- x" is never taken for a file header.
export function parseDiff(text: string): DiffLine[] {
  const out: DiffLine[] = []
  let o = 0
  let n = 0
  let left = { o: 0, n: 0 }
  for (const raw of text.split('\n')) {
    if (left.o <= 0 && left.n <= 0) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
      if (!m) continue // file headers, "\ No newline" markers, trailing blank
      o = Number(m[1])
      n = Number(m[3])
      left = { o: m[2] === undefined ? 1 : Number(m[2]), n: m[4] === undefined ? 1 : Number(m[4]) }
      if (left.o === 0) o += 1 // a side with no lines starts one past the number it prints
      if (left.n === 0) n += 1
      out.push({ k: 'h', t: raw })
      continue
    }
    const c = raw[0]
    if (c === '+') {
      out.push({ k: 'a', n, t: raw.slice(1) })
      n++
      left.n--
    } else if (c === '-') {
      out.push({ k: 'd', o, t: raw.slice(1) })
      o++
      left.o--
    } else if (c === '\\') {
      continue
    } else {
      out.push({ k: 'c', o, n, t: raw.slice(1) })
      o++
      n++
      left.o--
      left.n--
    }
  }
  return out
}

// "path:L12-15", the lines quoted as a diff, then what the person said.
export function formatComment(path: string, lines: DiffLine[], text: string): string {
  const news = lines.filter(l => l.n !== undefined).map(l => l.n as number)
  const olds = lines.filter(l => l.o !== undefined).map(l => l.o as number)
  const nums = news.length ? news : olds
  const lo = Math.min(...nums)
  const hi = Math.max(...nums)
  const where = `${path}:L${lo === hi ? lo : `${lo}-${hi}`}${news.length ? '' : ' (removed)'}`
  const shown = lines.slice(0, 12).map(l => `> ${l.k === 'a' ? '+' : l.k === 'd' ? '-' : ' '}${l.t}`)
  if (lines.length > 12) shown.push(`> … ${lines.length - 12} more lines`)
  return `${where}\n${shown.join('\n')}\n\n${text}`
}

// What "Send review" and "Send now" put on the clipboard.
export function formatReview(comments: ReviewComment[], ref: string): string {
  const head = `Code review comments${ref ? ` on ${ref}` : ''} (${comments.length}):`
  return `${head}\n\n${comments.map(c => formatComment(c.path, c.lines, c.text)).join('\n\n---\n\n')}`
}

// A file with no earlier version, as a diff that adds every line.
export function addedDiff(text: string): string {
  if (text === '') return ''
  const rows = text.replace(/\n$/, '').split('\n')
  return `@@ -0,0 +1,${rows.length} @@\n${rows.map(r => `+${r}`).join('\n')}`
}
