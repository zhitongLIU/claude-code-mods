// plan-control: /plan-control opens a live map of a piece of work — Obeya tickets and local plan files, the
// dependencies between them, the interfaces each provides and consumes, mismatches, pull requests.
// One map per Claude session, kept under ~/.plan-control/ (maps/, the shared Obeya cache, extracted contracts).
// A mod cannot call Obeya: it asks Claude to read a ticket and takes the raw result as it passes (tool.call),
// so Claude never writes anything back. The page re-reads data.js; index.html never changes.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Band } from '../types'
import { buildPlan, emptyMap, KEY_RE, parseRefs, summarize } from './build'
import type { Extracted, MapFile, PlanData, PrRow } from './build'

const STALE_MS = 10 * 60_000 // /plan-control refresh reads a cached Obeya ticket again past this age
const ASK_AGAIN_MS = 2 * 60_000 // a ticket asked for is not asked for again sooner, unless the person says refresh
const PR_EVERY_MS = 60_000
const MAP_TTL_MS = 30 * 24 * 3600_000
const READ_TOOL = 'mcp__obeya__obeya_get_task_context'
const WRITE_TOOL = 'mcp__obeya__obeya_write_plan'

// The module's own bookkeeping. A reload starts it over, and session.start reads the map back from disk.
const s = {
  sid: '',
  root: '',
  home: '',
  cwd: '',
  org: '', // $PLAN_CONTROL_GITHUB_ORG: the GitHub owner of every service repo; a ticket's service names its repo
  ticketUrl: '', // $PLAN_CONTROL_TICKET_URL: where a ticket key opens, `{key}` replaced
  map: emptyMap(''),
  on: false, // the page is open and kept up to date
  active: false, // the person used /plan-control in this session: the mod may ask Claude to read tickets
  written: false, // index.html is in the page folder
  last: '', // the data.js last written
  pending: false,
  dirty: false,
  turn: false, // a main turn is running: asking Claude waits for it to end
  queue: new Set<string>(), // Obeya keys to ask Claude to read
  asked: new Map<string, number>(),
  mtimes: new Map<string, number>(), // plan files on the map, by path
  prs: new Map<string, { rows: PrRow[]; at: number; loading?: boolean }>(),
  bridge: { base: undefined as string | undefined, starting: undefined as Promise<string | undefined> | undefined, stop: false },
}

// The band's figures, held by the host so the band redraws when they change.
const band = atom({ plugin: 'plan-control', key: 'band' } as const, { title: '', tickets: 0, done: 0, ready: 0, reading: 0, mismatches: 0, link: '' } as Band)

const dirs = () => ({ maps: `${s.root}/maps`, cache: `${s.root}/cache/obeya`, extracted: `${s.root}/extracted`, page: `${s.root}/pages/${s.sid}` })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.sid = (await $.session.id().catch(() => '')).replace(/[^\w-]/g, '') || 'session'
    s.home = ((await $.env.get('HOME')) ?? '').replace(/\/$/, '')
    s.root = `${s.home}/.plan-control`
    s.org = (await $.env.get('PLAN_CONTROL_GITHUB_ORG')) ?? ''
    s.ticketUrl = (await $.env.get('PLAN_CONTROL_TICKET_URL')) ?? ''
    s.cwd = e.cwd
    s.map = (await readMap($, s.sid)) ?? emptyMap(e.cwd)
    await $.command
      .register({ name: 'plan-control', description: 'Open the live map of tickets and plans; add puts an Obeya ticket (with its sub-tickets), a link or a plan file on it', argumentHint: '[<key|link|path> … | add … | remove <id> | refresh [all|<id>] | maps | attach <map> | off]' })
      .catch(() => {})
    $.clock.every(2000, () => void tick($).catch(() => {}))
    void prune($).catch(() => {})
    if (s.map.sources.length) void publish($) // the band shows a map this session already has
    return r
  })

  // The band: the map's state while this session has one, and the page's address while it is served:
  // Cmd-click it (or run /plan-control again) to reopen a tab that was closed.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    const b = await read($, band)
    if (e.props.hasSurvey || (!b.tickets && !b.link)) return rest
    const { Box, Text, Link } = $.ui.resolve(e)
    const link = b.link || undefined
    const port = link ? /:(\d+)\//.exec(link)?.[1] : undefined
    const parts = [`${b.tickets} tickets`, `${b.done} done`, `${b.ready} ready`, ...(b.reading ? [`reading ${b.reading}…`] : [])]
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color="magenta" bold>{' ◇ plan: '}</Text>
          {b.title ? <Text>{`${b.title.split(' · ')[0]} · `}</Text> : null}
          <Text>{parts.join(' · ')}</Text>
          {b.mismatches ? <Text color="red">{` · ⚑ ${b.mismatches} mismatch${b.mismatches === 1 ? '' : 'es'}`}</Text> : null}
          {link ? <Text dimColor>{'  ·  '}<Link href={link} label={`localhost:${port} ↗`} /></Text> : <Text dimColor>{'  ·  /plan-control'}</Text>}
        </Text>
        {rest}
      </Box>
    )
  })

  on('command.run', { command: 'plan-control' }, async ($, e) => run($, e.args))

  on('turn.start', async ($, e, next) => {
    if (!(e as unknown as { agentId?: string }).agentId) s.turn = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      s.turn = false
      $.clock.after(300, () => void flush($).catch(() => {}))
    }
    return r
  })

  // Every ticket Claude reads goes to the shared cache as it passes: the map redraws, nobody re-writes it.
  on('tool.call', { tool: READ_TOOL }, async ($, e, next) => {
    const r = await next(e)
    const input = e as unknown as { taskKey?: unknown; for?: unknown }
    const key = String(input.taskKey ?? '')
    // Only 'implement' carries the current plan; a 'review' read shows the approved one.
    if (r.deny === undefined && r.isError !== true && KEY_RE.test(key) && input.for !== 'review') {
      const text = textOf((r as { result?: unknown }).result)
      if (text.includes('## 1. IDENTITY')) {
        await $.fs.write(`${dirs().cache}/${key}.md`, text).catch(() => {})
        s.queue.delete(key)
        await publish($)
      }
    }
    return r
  }).catch(($, e, next) => next(e)) // never in the way of the call: a failure here replays what next settled to

  // A plan Claude rewrote is read again once the turn ends.
  on('tool.call', { tool: WRITE_TOOL }, async ($, e, next) => {
    const r = await next(e)
    const key = String((e as unknown as { taskKey?: unknown }).taskKey ?? '')
    if (r.deny === undefined && r.isError !== true && KEY_RE.test(key)) {
      s.asked.delete(key)
      s.queue.add(key)
    }
    return r
  }).catch(($, e, next) => next(e))
}

// /plan-control [refs | add refs | remove id | refresh [all|<id>] | maps | attach map | off]
async function run($: EngineInterface, args: string) {
  const arg = args.trim()
  const [cmd = '', ...rest] = arg.split(/\s+/)
  const tail = rest.join(' ')
  s.active = true
  switch (cmd.toLowerCase()) {
    case '':
      return { text: await open($) }
    case 'off':
      s.on = false
      s.bridge.stop = true // the server's read loop ends at its next beat, which ends the server
      s.bridge.base = undefined
      s.bridge.starting = undefined
      await publish($) // the band drops the link
      return { text: 'plan-control: page stopped. /plan-control opens it again; the map is kept.' }
    case 'add':
      return { text: await add($, tail) }
    case 'remove':
      return { text: await remove($, tail) }
    case 'refresh':
      return { text: await refresh($, tail) }
    case 'maps':
      return { text: await listMaps($) }
    case 'attach':
      return { text: await attach($, tail) }
    default: {
      // `/plan-control CAO-219` adds and opens in one go
      const added = await add($, arg)
      return { text: `${added}\n${await open($)}` }
    }
  }
}

async function open($: EngineInterface) {
  s.on = true
  s.last = ''
  await writePage($)
  const base = await startBridge($)
  const opened = await openPage($, base)
  const n = s.map.sources.length
  return n ? `plan-control: ${s.map.title || 'map'} · ${n} source${n === 1 ? '' : 's'}. ${opened}` : `plan-control: the map is empty: /plan-control add CAO-219 (an Obeya ticket and its sub-tickets), a link or a plan file. ${opened}`
}

function absolute(p: string) {
  if (p.startsWith('/')) return p
  if (p === '~' || p.startsWith('~/')) return `${s.home}${p.slice(1)}`
  return `${s.cwd.replace(/\/$/, '')}/${p.replace(/^\.\//, '')}`
}

async function add($: EngineInterface, text: string) {
  const { keys, paths, only } = parseRefs(text)
  if (!keys.length && !paths.length) return 'plan-control: give an Obeya key (CAO-219), its link, a plan file or a folder of plans.'
  const added: string[] = []
  const notes: string[] = []
  const now = new Date().toISOString()
  const has = (ref: string) => s.map.sources.some(x => x.ref === ref)
  for (const key of keys) {
    s.map.excluded = s.map.excluded.filter(k => k !== key)
    if (has(key)) continue
    s.map.sources.push({ ref: key, kind: 'obeya', children: !only, addedAt: now })
    added.push(only ? `${key} (alone)` : key)
    if (!(await $.fs.exists(`${dirs().cache}/${key}.md`).catch(() => false))) s.queue.add(key)
  }
  for (const p of paths) {
    const path = absolute(p)
    const st = await $.fs.stat(path).catch(() => undefined)
    if (!st) {
      notes.push(`${p}: not found`)
      continue
    }
    const list = st.kind === 'dir' ? ((await $.fs.list(path).catch(() => [])) ?? []).filter(f => f.kind === 'file' && /\.md$/i.test(f.name)).map(f => `${path.replace(/\/$/, '')}/${f.name}`) : [path]
    if (!list.length) notes.push(`${p}: no .md plan in it`)
    for (const f of list) {
      if (has(f)) continue
      s.map.sources.push({ ref: f, kind: 'file', addedAt: now })
      added.push(f.split('/').pop() ?? f)
    }
  }
  await saveMap($)
  await publish($)
  $.clock.after(300, () => void flush($).catch(() => {}))
  const asking = s.queue.size ? ` Asking Claude to read ${[...s.queue].join(', ')} from Obeya.` : ''
  return `plan-control: ${added.length ? `added ${added.join(', ')}.` : 'nothing new to add.'}${notes.length ? ` ${notes.join('; ')}.` : ''}${asking}`
}

async function remove($: EngineInterface, id: string) {
  const ref = id.trim()
  if (!ref) return 'plan-control: give the id of a ticket on the map.'
  const before = s.map.sources.length
  s.map.sources = s.map.sources.filter(x => x.ref !== ref && x.ref !== absolute(ref) && !(x.kind === 'file' && x.ref.endsWith(`/${ref}`)))
  if (s.map.sources.length === before) {
    // a sub-ticket of a parent on the map, or a plan file known by its id
    const data = await collectPlan($)
    const t = data.tickets.find(x => x.key === ref)
    if (!t) return `plan-control: ${ref} is not on the map.`
    if (t.path) s.map.sources = s.map.sources.filter(x => x.ref !== t.path)
    else if (!s.map.excluded.includes(ref)) s.map.excluded.push(ref)
  }
  await saveMap($)
  await publish($)
  return `plan-control: ${ref} taken off the map.`
}

// Where the person dropped a box on the page ("KEY x y"), or "KEY reset" / "* reset" to put boxes back.
async function move($: EngineInterface, text: string) {
  const next = applyMove(s.map.positions, text)
  if (!next) return
  s.map.positions = next
  await saveMap($)
  await publish($)
}

export function applyMove(positions: MapFile['positions'], text: string): MapFile['positions'] | undefined {
  const [key = '', a = '', b] = text.trim().split(/\s+/)
  if (key === '*' && a === 'reset') return {}
  if (!/^[\w.-]+$/.test(key)) return undefined
  if (a === 'reset') {
    const { [key]: _, ...rest } = positions
    return rest
  }
  const x = Number(a)
  const y = Number(b)
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e5 || Math.abs(y) > 1e5) return undefined
  return { ...positions, [key]: { x: Math.round(x), y: Math.round(y) } }
}

// `refresh` reads again the Obeya tickets older than STALE_MS; `refresh all` (the page's button) every ticket;
// `refresh CAO-231`, a plan file's id or its path, that one. Plan files are re-read from disk, Obeya tickets by Claude.
async function refresh($: EngineInterface, arg = '') {
  const want = arg.trim()
  const all = want.toLowerCase() === 'all'
  const force = want !== ''
  const data = await collectPlan($)
  const now = Date.now()
  const keys = new Set([...s.map.sources.filter(x => x.kind === 'obeya').map(x => x.ref), ...data.tickets.filter(t => t.kind === 'obeya').map(t => t.key)])
  let files = s.map.sources.filter(x => x.kind === 'file').map(x => x.ref)
  if (force && !all) {
    const t = data.tickets.find(x => x.key.toUpperCase() === want.toUpperCase() || (x.path !== undefined && (x.path === absolute(want) || x.path.endsWith(`/${want}`))))
    if (!t) return `plan-control: ${want} is not on the map.`
    for (const k of [...keys]) if (k !== t.key) keys.delete(k)
    files = t.path ? [t.path] : []
    if (t.path) keys.clear()
  }
  for (const key of keys) {
    const st = force ? undefined : await $.fs.stat(`${dirs().cache}/${key}.md`).catch(() => undefined)
    if (!st || now - st.mtimeMs > STALE_MS) {
      s.asked.delete(key)
      s.queue.add(key)
    }
  }
  for (const f of files) s.mtimes.delete(f) // the next tick sees the file as changed and redraws from disk
  s.prs.clear()
  s.last = '' // redraw even when nothing changed, so the page shows the refresh happened
  await publish($)
  $.clock.after(300, () => void flush($).catch(() => {}))
  const n = s.queue.size
  const read = files.length ? `re-read ${files.length} plan file${files.length === 1 ? '' : 's'}` : ''
  const ask = n ? `asking Claude to read ${n} Obeya ticket${n === 1 ? '' : 's'}${force ? '' : ` older than ${STALE_MS / 60_000} minutes`}` : ''
  return `plan-control: refreshing; ${[read, ask].filter(Boolean).join('; ') || 'every ticket was read recently'}.`
}

// Asks Claude to read the queued Obeya tickets, once no turn is running; the tool.call hook does the rest.
async function flush($: EngineInterface) {
  if (s.turn || !s.queue.size) return
  const now = Date.now()
  const keys = [...s.queue].filter(k => now - (s.asked.get(k) ?? 0) > ASK_AGAIN_MS).slice(0, 15)
  if (!keys.length) return
  for (const k of keys) s.asked.set(k, now)
  await $.prompt.submit({ text: `[plan-control] Read these Obeya tickets with obeya_get_task_context (for: "implement"), one call each, then reply only "ok": ${keys.join(', ')}` })
}

// ---- the map file ----

async function readMap($: EngineInterface, sid: string): Promise<MapFile | undefined> {
  const raw = await $.fs.read(`${dirs().maps}/${sid}.json`).catch(() => undefined)
  if (typeof raw !== 'string') return undefined
  try {
    const m = JSON.parse(raw) as Partial<MapFile>
    return { ...emptyMap(s.cwd), ...m, sources: Array.isArray(m.sources) ? m.sources : [], excluded: Array.isArray(m.excluded) ? m.excluded : [] }
  } catch {
    return undefined
  }
}

async function saveMap($: EngineInterface) {
  s.map.updatedAt = new Date().toISOString()
  s.map.cwd = s.cwd
  await $.fs.write(`${dirs().maps}/${s.sid}.json`, JSON.stringify(s.map, null, 2))
}

async function savedMaps($: EngineInterface) {
  const entries = ((await $.fs.list(dirs().maps).catch(() => [])) ?? []).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
  const out: { sid: string; map: MapFile }[] = []
  for (const f of entries) {
    const sid = f.name.replace(/\.json$/, '')
    const map = await readMap($, sid)
    if (map && !map.movedTo && map.sources.length) out.push({ sid, map })
  }
  return out.sort((a, b) => b.map.updatedAt.localeCompare(a.map.updatedAt))
}

async function listMaps($: EngineInterface) {
  const list = await savedMaps($)
  if (!list.length) return 'plan-control: no saved map yet.'
  const lines = list.map(({ sid, map }, i) => `${i + 1}. ${map.title || '(untitled)'} · ${map.sources.length} source${map.sources.length === 1 ? '' : 's'} · ${map.updatedAt.slice(0, 16).replace('T', ' ')} · ${sid.slice(0, 8)}${sid === s.sid ? ' (this session)' : ''}`)
  return `plan-control maps:\n${lines.join('\n')}\n/plan-control attach <number | id | part of the title> takes one over in this session.`
}

// Takes over a saved map: it becomes this session's, and the old file points here, so two sessions never share one.
async function attach($: EngineInterface, arg: string) {
  const list = await savedMaps($)
  const q = arg.trim()
  const n = Number(q)
  const hit = Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1] : list.find(x => x.sid.startsWith(q) || (q && x.map.title.toLowerCase().includes(q.toLowerCase())))
  if (!q || !hit) return `plan-control: no saved map matches "${q}". /plan-control maps lists them.`
  if (hit.sid === s.sid) return 'plan-control: that map is already this session’s.'
  s.map = { ...hit.map, movedTo: undefined }
  await saveMap($)
  await $.fs.write(`${dirs().maps}/${hit.sid}.json`, JSON.stringify({ ...hit.map, movedTo: s.sid }, null, 2))
  s.mtimes.clear()
  await publish($)
  return `plan-control: attached “${s.map.title || hit.sid}” (${s.map.sources.length} sources).${s.on ? '' : ' /plan-control opens it.'}`
}

// Maps untouched for 30 days, and the stubs attach leaves, are deleted; nothing outside ~/.plan-control/maps.
async function prune($: EngineInterface) {
  const entries = ((await $.fs.list(dirs().maps).catch(() => [])) ?? []).filter(f => f.kind === 'file' && /^[\w-]+\.json$/.test(f.name))
  const old = entries.filter(f => Date.now() - f.mtimeMs > MAP_TTL_MS).map(f => `${dirs().maps}/${f.name}`)
  if (old.length) await $.process.run(['rm', '-f', ...old], { timeoutMs: 10_000 }).catch(() => {})
}

// ---- data ----

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  const raw = await $.fs.read(path).catch(() => undefined)
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

async function context($: EngineInterface, key: string, into: Record<string, { text: string; at: number }>) {
  if (into[key]) return into[key]
  const path = `${dirs().cache}/${key}.md`
  const st = await $.fs.stat(path).catch(() => undefined)
  const text = st ? await $.fs.read(path).catch(() => undefined) : undefined
  if (st && typeof text === 'string') into[key] = { text, at: st.mtimeMs }
  return into[key]
}

// Everything buildPlan needs, read from disk; pull requests from the per-repo cache.
async function collectPlan($: EngineInterface): Promise<PlanData> {
  const contexts: Record<string, { text: string; at: number }> = {}
  const files: Record<string, string> = {}
  for (const src of s.map.sources) {
    if (src.kind === 'file') {
      const text = await $.fs.read(src.ref).catch(() => undefined)
      if (typeof text === 'string') files[src.ref] = text
      continue
    }
    const own = await context($, src.ref, contexts)
    // sub-tickets: their own cached reads, when there are some
    for (const m of own?.text.matchAll(/- \*\*([A-Z][A-Z0-9]+-\d+)\*\*/g) ?? []) await context($, m[1] as string, contexts)
  }
  const extracted: Extracted[] = []
  for (const f of ((await $.fs.list(dirs().extracted).catch(() => [])) ?? []).filter(x => x.kind === 'file' && x.name.endsWith('.json'))) {
    const x = await readJson<Extracted>($, `${dirs().extracted}/${f.name}`)
    if (x) extracted.push(x)
  }
  // the other plans in the folders of plan files on the map, so a blocker not on the map can open its file
  const nearby: Record<string, string> = {}
  const folders = new Set(s.map.sources.filter(x => x.kind === 'file').map(x => x.ref.replace(/\/[^/]*$/, '')))
  for (const dir of folders) {
    for (const f of ((await $.fs.list(dir).catch(() => [])) ?? []).filter(x => x.kind === 'file' && /\.md$/i.test(x.name))) {
      const path = `${dir}/${f.name}`
      if (files[path] !== undefined) continue
      const text = await $.fs.read(path).catch(() => undefined)
      if (typeof text === 'string') nearby[path] = text
    }
  }
  const prs: Record<string, PrRow[]> = {}
  for (const [repo, v] of s.prs) prs[repo] = v.rows
  return buildPlan({ map: s.map, contexts, files, extracted, prs, ticketUrl: s.ticketUrl, nearby })
}

// A repo's pull requests, fetched in the background once a minute while the page is open.
function fetchPrs($: EngineInterface, repo: string) {
  const had = s.prs.get(repo)
  if (!s.org || !/^[\w.-]+$/.test(repo) || repo === 'other' || had?.loading || (had && Date.now() - had.at < PR_EVERY_MS)) return
  s.prs.set(repo, { rows: had?.rows ?? [], at: had?.at ?? 0, loading: true })
  void $.process
    .run(['gh', 'pr', 'list', '-R', `${s.org}/${repo}`, '--state', 'all', '--limit', '300', '--json', 'headRefName,title,number,state,isDraft,url'], { timeoutMs: 30_000 })
    .then(r => {
      let rows: PrRow[] = had?.rows ?? []
      try {
        if (r.exitCode === 0) rows = JSON.parse(r.stdout) as PrRow[]
      } catch {}
      const changed = JSON.stringify(rows) !== JSON.stringify(had?.rows ?? [])
      s.prs.set(repo, { rows, at: Date.now() })
      if (changed) void publish($)
    })
    .catch(() => s.prs.set(repo, { rows: had?.rows ?? [], at: Date.now() }))
}

// ---- the page ----

async function tick($: EngineInterface) {
  if (!s.on) return
  let changed = false
  for (const src of s.map.sources) {
    if (src.kind !== 'file') continue
    const st = await $.fs.stat(src.ref).catch(() => undefined)
    const m = st?.mtimeMs ?? 0
    if (s.mtimes.get(src.ref) !== m) {
      s.mtimes.set(src.ref, m)
      changed = true
    }
  }
  if (changed || [...s.prs.values()].some(v => Date.now() - v.at >= PR_EVERY_MS)) await publish($)
}

// Rebuilds the map about once a second at most: the band always, data.js while the page is open.
async function publish($: EngineInterface) {
  if (s.pending) {
    s.dirty = true
    return
  }
  s.pending = true
  s.dirty = false
  $.clock.after(300, () => {
    void writePage($)
      .catch(() => {})
      .finally(() => {
        s.pending = false
        if (s.dirty) void publish($).catch(() => {})
      })
  })
}

async function writePage($: EngineInterface) {
  const data = await collectPlan($)
  const next: Band = { ...summarize(data), link: s.bridge.base ? `${s.bridge.base}/` : '' }
  if (JSON.stringify(next) !== JSON.stringify(await read($, band))) await update($, band, () => next)
  if (s.on) for (const t of data.tickets) if (t.kind === 'obeya' || /^[A-Z][A-Z0-9]+-\d+$/.test(t.key)) fetchPrs($, t.service)
  // A sub-ticket never read is asked for once, so its Contract header and branch reach the map; only once the
  // person used /plan-control in this session, so a map restored at start never makes Claude read on its own.
  if (s.active) {
    for (const t of data.tickets) if (t.kind === 'obeya' && !(await $.fs.exists(`${dirs().cache}/${t.key}.md`).catch(() => true)) && !s.asked.has(t.key)) s.queue.add(t.key)
    for (const k of data.missing) if (!s.asked.has(k)) s.queue.add(k)
    if (s.queue.size) $.clock.after(300, () => void flush($).catch(() => {}))
  }
  if (!s.map.title && data.epics[0]) {
    s.map.title = `${data.epics[0].key} · ${data.epics[0].title}`
    await saveMap($)
  }
  if (!s.on) return
  const json = JSON.stringify({ ...data, server: Boolean(s.bridge.base) }).replace(/</g, '\\u003c')
  if (json === s.last) return
  const dir = dirs().page
  if (!s.written) {
    const html = await $.fs.read(`${$.plugin.root}/page/index.html`)
    await $.fs.write(`${dir}/index.html`, typeof html === 'string' ? html : '')
    s.written = true
  }
  await $.fs.write(`${dir}/data.js`, `window.PLAN = ${json};`)
  s.last = json
}

// An MCP tool's result reaches a hook as a string, an array of content blocks, or { content: [...] }.
export function textOf(response: unknown): string {
  if (typeof response === 'string') return response
  if (Array.isArray(response)) return response.map(textOf).join('\n')
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>
    if (typeof r.text === 'string') return r.text
    if (r.content !== undefined) return textOf(r.content)
  }
  return ''
}

// One line of the server's stdout, or undefined for anything else.
export function parseLine(line: string): { ready: true; port: number; token: string } | { send: string } | { add: string } | { remove: string } | { move: string } | { refresh: string } | undefined {
  try {
    const v = JSON.parse(line) as Record<string, unknown>
    if (v.ready === true && typeof v.port === 'number' && typeof v.token === 'string' && /^\w+$/.test(v.token)) return { ready: true, port: v.port, token: v.token }
    if (typeof v.send === 'string') return { send: v.send }
    if (typeof v.add === 'string') return { add: v.add }
    if (typeof v.remove === 'string') return { remove: v.remove }
    if (typeof v.move === 'string') return { move: v.move }
    if (typeof v.refresh === 'string') return { refresh: v.refresh }
  } catch {}
  return undefined
}

// A port in 20000-59999 from the session id, the same every time, so the page keeps its origin.
export function portFor(sid: string) {
  let h = 11
  for (const c of `plan:${sid}`) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0
  return 20000 + (h % 40000)
}

// Starts the page's server once; resolves its address, or undefined where Node is missing (the page then opens from disk).
function startBridge($: EngineInterface): Promise<string | undefined> {
  if (s.bridge.base) return Promise.resolve(s.bridge.base)
  s.bridge.starting ??= new Promise<string | undefined>(resolve => {
    s.bridge.stop = false
    $.clock.after(4000, () => resolve(undefined))
    void (async () => {
      let rest = ''
      for await (const piece of $.process.spawn({ argv: ['node', `${$.plugin.root}/page/server.mjs`, dirs().page, String(portFor(s.sid))] })) {
        if (s.bridge.stop) break // leaving the loop ends the child
        const { stream, text } = piece as { stream?: string; text?: string }
        if (stream !== 'stdout' || text === undefined) continue
        const parts = (rest + text).split('\n')
        rest = parts.pop() ?? ''
        for (const line of parts) {
          const msg = parseLine(line)
          if (!msg) continue
          if ('ready' in msg) {
            s.bridge.base = `http://localhost:${msg.port}/${msg.token}` // localhost: the only plain-http link every surface draws
            s.last = '' // data.js says the server is up
            void publish($)
            resolve(s.bridge.base)
          } else if ('send' in msg) void $.prompt.submit({ text: msg.send }).catch(() => {})
          else if ('add' in msg) {
            s.active = true
            void add($, msg.add).catch(() => {})
          }
          else if ('remove' in msg) void remove($, msg.remove).catch(() => {})
          else if ('move' in msg) void move($, msg.move).catch(() => {})
          else if ('refresh' in msg) void refresh($, msg.refresh).catch(() => {})
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        s.bridge.base = undefined
        s.bridge.starting = undefined
        resolve(undefined)
        void publish($).catch(() => {}) // the band drops the link
      })
  })
  return s.bridge.starting
}

async function focusedWorkspace($: EngineInterface) {
  const r = await $.process.run(['cmux', 'identify'], { timeoutMs: 3_000 }).catch(() => ({ exitCode: 1, stdout: '' }))
  if (r.exitCode !== 0) return undefined
  try {
    const ref = (JSON.parse(r.stdout) as { focused?: { workspace_ref?: unknown } }).focused?.workspace_ref
    return typeof ref === 'string' && /^[\w:-]+$/.test(ref) ? ref : undefined
  } catch {
    return undefined
  }
}

// In a cmux split inside cmux, else in the default browser.
async function openPage($: EngineInterface, base?: string) {
  const url = base ? `${base}/` : `file://${encodeURI(dirs().page)}/index.html`
  const inCmux = Boolean(await $.env.get('CMUX_WORKSPACE_ID'))
  const workspace = inCmux ? await focusedWorkspace($) : undefined
  const argv = inCmux ? ['cmux', 'browser', 'open-split', url, '--focus', 'true', ...(workspace ? ['--workspace', workspace] : [])] : ['open', url]
  const r = await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => ({ exitCode: 1 }))
  return r.exitCode === 0 ? `Opened ${url}` : `Could not open a browser. Open ${url} yourself.`
}
