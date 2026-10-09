// The "code" view: files Claude touched, the imports between them, handed to the HTML page as data.
import type { MapFile } from '../types'

const stripExt = (p: string) => p.replace(/\.(tsx?|jsx?|mjs|cjs|py|go|rs|rb|vue|svelte)$/, '').replace(/\/index$/, '')

function join(dir: string, rel: string) {
  const parts = dir.split('/')
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

// Relative imports in a source file, resolved against its folder, extension stripped.
export function importsOf(path: string, text: string): string[] {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const found = new Set<string>()
  const js = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g
  for (const m of text.matchAll(js)) found.add(stripExt(join(dir, m[1] as string)))
  const py = /^\s*from\s+(\.+)([\w.]*)\s+import/gm
  for (const m of text.matchAll(py)) {
    const ups = (m[1] as string).length - 1
    let base = dir
    for (let i = 0; i < ups; i++) base = base.slice(0, base.lastIndexOf('/'))
    if (m[2]) found.add(`${base}/${(m[2] as string).replace(/\./g, '/')}`)
  }
  return [...found]
}

export type Edge = { from: string; to: string }

export function edges(files: MapFile[]): Edge[] {
  const byBase = new Map(files.map(f => [stripExt(f.path), f.path]))
  const out: Edge[] = []
  for (const f of files) for (const target of f.imports) {
    const to = byBase.get(target)
    if (to && to !== f.path) out.push({ from: f.path, to })
  }
  return out
}

// Columns by import depth: a file goes one column right of the files that import it.
export function layout(files: MapFile[], es: Edge[]) {
  const depth = new Map(files.map(f => [f.path, 0]))
  for (let pass = 0; pass < files.length; pass++) {
    let moved = false
    for (const e of es) {
      const want = (depth.get(e.from) ?? 0) + 1
      if (want > (depth.get(e.to) ?? 0) && want < 5) {
        depth.set(e.to, want)
        moved = true
      }
    }
    if (!moved) break
  }
  const columns: string[][] = []
  for (const f of files) {
    const d = depth.get(f.path) ?? 0
    ;(columns[d] ??= []).push(f.path)
  }
  return columns.filter(Boolean)
}

export type Look = { at: number; turn: number }

export type MapCard = {
  id: string
  title: string
  sub: string
  why?: string
  state: 'read' | 'edit' | 'changed' | null // what the card glows for: being read, being edited, changed this turn
  live: boolean // touched in the last few seconds
}

export type MapData = {
  files: number
  changed: number
  now: string // "reading login.tsx", or ''
  nowState: 'read' | 'edit' | null
  columns: MapCard[][] // by import depth
  edges: { from: string; to: string; hot: boolean }[]
  extra: string[] // files only read and linked to nothing
}

// Everything the page draws, as plain data: the template lays it out and draws the arrows.
export function mapData(files: MapFile[], look: Look): MapData {
  const { at, turn } = look
  const isChanged = (f: MapFile) => f.changedTurn === turn && turn > 0
  const isLive = (f: MapFile) => at - f.at < 5000
  const es = edges(files)
  const linked = new Set(es.flatMap(e => [e.from, e.to]))
  const main = files.filter(f => linked.has(f.path) || isChanged(f) || isLive(f) || f.act !== 'read')
  const extra = files.filter(f => !main.includes(f))
  const mainEs = es.filter(e => main.some(f => f.path === e.from) && main.some(f => f.path === e.to))
  const byPath = new Map(main.map(f => [f.path, f]))
  const title = (f: MapFile) => titleOf(f.path, files.map(x => x.path))
  const readLike = (f: MapFile) => f.act === 'read' || f.act === 'search'

  const card = (p: string): MapCard => {
    const f = byPath.get(p) as MapFile
    const live = isLive(f)
    const state = live ? (readLike(f) ? 'read' : 'edit') : isChanged(f) ? 'changed' : null
    return { id: p, title: title(f), sub: folder(p, 2), why: f.why, state, live }
  }
  const newest = files.filter(isLive).sort((a, b) => b.at - a.at)[0]
  return {
    files: files.length,
    changed: files.filter(isChanged).length,
    now: newest ? `${newest.act === 'read' ? 'reading' : newest.act === 'search' ? 'searching' : 'editing'} ${title(newest)}` : '',
    nowState: newest ? (readLike(newest) ? 'read' : 'edit') : null,
    columns: layout(main, mainEs).map(col => col.map(card)),
    edges: mainEs.map(e => ({ ...e, hot: [e.from, e.to].some(p => isChanged(byPath.get(p) as MapFile) || isLive(byPath.get(p) as MapFile)) })),
    extra: extra.map(title),
  }
}

// A file's name, or with several of that name the nearest folder that tells them apart:
// three `hooks/register.tsx` read as `merge-gate › register.tsx`, `snake › register.tsx`.
export function titleOf(path: string, all: string[]) {
  const name = base(path)
  const same = all.filter(p => base(p) === name && p !== path)
  if (same.length === 0) return name
  const parts = path.split('/')
  for (let k = 2; k <= parts.length; k++) {
    const seg = parts[parts.length - k]
    if (same.every(p => p.split('/').at(-k) !== seg)) return `${seg} › ${name}`
  }
  return `${folder(path)}/${name}`
}

function base(path: string) {
  return path.split('/').pop() ?? path
}

// The last `n` folders of a path (`n` 1: the parent).
function folder(path: string, n = 1) {
  return path.split('/').slice(-1 - n, -1).join('/')
}
