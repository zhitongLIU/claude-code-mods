// Mission Control: /mission opens a live web page with two tabs for the current turn.
//   who  · the main loop, its subagents and every tool call they make, live
//   code · a map of the files Claude reads and edits, the imports between
//          them, a glow on what it touches right now, and one line on each change
// A band line sums it up while Claude works. The page re-reads data.js every second.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MapFile, MissionNode } from '../types'
import { linksOf } from './lang'
import { mapData } from './map'
import { TEMPLATE } from './template'
import { label, lines, summary } from './tree'

const MAX_NODES = 300
const MAX_FILES = 14
const BAND_AFTER_MS = 30_000 // the band stays this long after a turn ends
// Tools that are Claude Code's own bookkeeping, not work: kept out of the tree.
const INTERNAL = new Set(['SubagentHandback', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])
// Files that belong on a code map: source, config and docs, not images or binaries.
export const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|vue|svelte|css|scss|html|md|mdx|json|ya?ml|toml|sh|sql|lua|ex|exs)$/i

// Held by the host, so a hot reload keeps the picture.
const nodes = atom({ plugin: 'mission', key: 'nodes' } as const, [] as MissionNode[])
const files = atom({ plugin: 'mission', key: 'files' } as const, [] as MapFile[])
const turn = atom({ plugin: 'mission', key: 'turn' } as const, 0)
const sid = atom({ plugin: 'mission', key: 'sid' } as const, '') // this session's folder name, so sessions never share a page

// The web page's bookkeeping; a reload starts it over. `on` once /mission has opened the page.
const page = { on: false, pending: false, dirty: false, last: '', written: false }
// The edits awaiting their one-line "why" live on the files atom (MapFile.edits), so a reload keeps
// them; the "why" is asked for lazily: no model call while nobody watches.
const asking = new Set<string>() // paths a model call is already explaining

// Under the cap, the oldest tool calls go first; main and the agents always stay.
export function cap(list: MissionNode[]) {
  if (list.length <= MAX_NODES) return list
  const tools = list.filter(n => n.kind === 'tool')
  const room = Math.max(0, MAX_NODES - (list.length - tools.length))
  const keep = new Set(room === 0 ? [] : tools.slice(-room))
  return list.filter(n => n.kind !== 'tool' || keep.has(n))
}

// The first `max` characters, cut at a word.
function words(text: string, max: number) {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.lastIndexOf(' ', max)
  return `${t.slice(0, cut > max * 0.5 ? cut : max)}…`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await update($, sid, () => String((r as { sessionId?: string }).sessionId ?? Math.random().toString(36).slice(2, 10)).replace(/[^\w-]/g, ''))
    await $.command.register({ name: 'mission', description: 'Open the live web page of agents, tool calls and the code map; /mission off stops it', argumentHint: '[who|code|off]' }).catch(() => {})
    $.clock.every(1000, () => {
      void (async () => {
        const busy = (await read($, nodes)).some(n => n.status === 'running')
        if (busy) await publish($) // the clocks on running calls tick
      })().catch(() => {})
    })
    return r
  })

  on('turn.start', async ($, e, next) => {
    const t = (await read($, turn)) + 1
    await update($, turn, () => t)
    const main: MissionNode = { id: 'main', parent: null, kind: 'main', label: `main · ${words(e.text, 50)}`, family: 'main', status: 'running', start: Date.now() }
    // A background agent still running from the last turn carries over, with its open calls.
    await update($, nodes, list => {
      const agents = list.filter(n => n.kind === 'agent' && n.status === 'running').map(a => ({ ...a, parent: 'main' }))
      const ids = new Set(agents.map(a => a.id))
      const open = list.filter(n => n.kind === 'tool' && n.status === 'running' && ids.has(n.parent ?? ''))
      return [main, ...agents, ...open]
    })
    await publish($)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const id = r.agentId
      const agent: MissionNode = { id, parent: e.parentAgentId ?? 'main', kind: 'agent', label: e.description || e.subagentType, family: 'agent', status: 'running', start: Date.now() }
      await update($, nodes, list => cap([...list, agent]))
      await publish($)
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Agent') return next(e) // its subagent shows up through agent.spawn
    if (INTERNAL.has(e.tool)) return next(e) // bookkeeping, not work a person would follow
    const args = e as unknown as Record<string, unknown>
    const { label: text, family } = label(args)
    const id = e.tool_use_id
    await update($, nodes, list => {
      // A call from an agent this tree does not know hangs off main rather than nowhere.
      const parent = e.agentId && list.some(n => n.id === e.agentId) ? e.agentId : 'main'
      return cap([...list, { id, parent, kind: 'tool', label: text, family, status: 'running', start: Date.now() }])
    })
    await publish($)
    const path = typeof args.file_path === 'string' ? args.file_path : undefined
    if (path) await touch($, path, e.tool === 'Read' ? 'read' : e.tool === 'Write' ? 'write' : e.tool === 'Edit' ? 'edit' : 'search', false)

    let failed = true
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
      failed = r.deny !== undefined || r.isError === true
    } finally {
      await update($, nodes, list => list.map(n => (n.id === id ? { ...n, status: failed ? 'failed' : 'done', end: Date.now() } : n)))
      await publish($)
    }
    if (path && !failed && (e.tool === 'Edit' || e.tool === 'Write')) {
      const what = e.tool === 'Edit' ? `- ${String(args.old_string ?? '').slice(0, 300)}\n+ ${String(args.new_string ?? '').slice(0, 300)}` : `wrote ${String(args.content ?? '').slice(0, 400)}`
      await touch($, path, e.tool === 'Edit' ? 'edit' : 'write', true, what)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const id = e.agentId ?? 'main'
    const failed = e.reason === 'error' || e.reason === 'aborted'
    const isMain = !e.agentId
    // The main turn ending closes everything it left marked running, so the clock can rest.
    await update($, nodes, list => {
      // Only main's own leftovers: a background agent still running keeps its open calls.
      const live = new Set(list.filter(n => n.kind === 'agent' && n.status === 'running' && n.id !== id).map(n => n.id))
      const close = (n: MissionNode) => n.id === id || (isMain && n.kind === 'tool' && !live.has(n.parent ?? ''))
      return list.map(n => (close(n) && n.status === 'running' ? { ...n, status: failed ? 'failed' : 'done', end: Date.now() } : n))
    })
    await publish($)
    if (isMain && page.on) void explainPending($).catch(() => {}) // in the background, so the turn ends at once
    return r
  })

  on('command.run', { command: 'mission' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const s = summary(await read($, nodes))
    if (arg === 'off') {
      page.on = false
      return { text: 'Mission Control: page stopped. /mission opens it again.' }
    }
    page.on = true
    await writePage($)
    const opened = await openPage($, arg === 'code' ? 'code' : 'who')
    void explainPending($).catch(() => {}) // the map is watched now: explain what changed while it was not
    return { text: `Mission Control: ${s.agents} agents · ${s.tools} tool calls · ${(await read($, files)).length} files. ${opened}` }
  })

  // The band: one summary line while Claude works, and for a short while after.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    const list = await read($, nodes)
    const main = list.find(n => n.kind === 'main')
    const s = summary(list)
    const isRecent = main !== undefined && (main.status === 'running' || Date.now() - (main.end ?? 0) < BAND_AFTER_MS)
    if (e.props.hasSurvey || !isRecent || s.tools + s.agents === 0) return rest
    const t = await read($, turn)
    const edited = (await read($, files)).filter(f => f.changedTurn === t).length
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color="blue" bold>{' ◈ mission: '}</Text>
          <Text>{`${s.agents ? `${s.running}/${s.agents} agents · ` : ''}${s.tools} tools${s.failed ? ` · ${s.failed} failed` : ''}${edited ? ` · ${edited} files changed` : ''}`}</Text>
          <Text dimColor>{'  ·  /mission'}</Text>
        </Text>
        {rest}
      </Box>
    )
  })
}

// Notes a file Claude touched, with what it links to (imports and mentioned names, per language).
async function touch($: EngineInterface, path: string, act: MapFile['act'], isChange: boolean, what?: string) {
  if (!CODE_FILE.test(path)) return // an image, a PDF, a lockfile: not code to map
  const t = await read($, turn)
  const text = await $.fs.read(path).catch(() => '')
  const links = typeof text === 'string' ? linksOf(path, text.slice(0, 200_000)) : { imports: [], names: [] } // imports sit near the top
  await update($, files, list => {
    const old = list.find(f => f.path === path)
    const edits = isChange && what ? (old?.editsTurn === t ? [...(old.edits ?? []), what] : [what]) : old?.edits
    const next: MapFile = { path, act, at: Date.now(), changedTurn: isChange ? t : (old?.changedTurn ?? 0), imports: links.imports.length ? links.imports : (old?.imports ?? []), names: links.names.length ? links.names : (old?.names ?? []), why: isChange ? undefined : old?.why, edits, editsTurn: isChange && what ? t : old?.editsTurn }
    return [...list.filter(f => f.path !== path), next].sort((a, b) => b.at - a.at).slice(0, MAX_FILES)
  })
  await publish($)
  $.clock.after(5500, () => void publish($).catch(() => {})) // again once the glow has faded
}

// One plain line per changed file that has none yet, from what changed in its last turn.
async function explainPending($: EngineInterface) {
  const todo = (await read($, files)).filter(f => f.edits?.length && !asking.has(f.path)).map(f => [f.path, { turn: f.editsTurn ?? 0, edits: f.edits ?? [] }] as const)
  if (todo.length === 0) return
  const paths = todo.map(([path]) => path)
  for (const path of paths) asking.add(path)
  try {
    const plain = (t: string) => t.replace(/[<>"]/g, ' ')
    const body = todo.map(([p, { edits }], i) => `<file n="${i + 1}" name="${plain(p.split('/').slice(-2).join('/'))}">\n${plain(edits.join('\n').slice(0, 1500))}\n</file>`).join('\n')
    const r = await $.model.complete({
      model: 'haiku',
      maxTokens: 400,
      system: 'For each file, say in plain words what changed, at most 60 characters, no em dashes. Reply with a JSON array of strings only, one per file, in the same order.',
      prompt: `${body}\n\nReply with the JSON array only: ${paths.length} strings.`,
    })
    if (!r.isAnswered) return
    let whys: unknown
    try {
      whys = JSON.parse(r.text.slice(r.text.indexOf('['), r.text.lastIndexOf(']') + 1))
    } catch {
      return
    }
    if (!Array.isArray(whys)) return
    // By position, so nothing has to match a path the model may have rewritten.
    const byPath = new Map(todo.map(([p, { turn: t }], i) => [p, { turn: t, why: typeof whys[i] === 'string' ? (whys[i] as string).replace(/\s*—\s*/g, ', ').slice(0, 80) : undefined }]))
    // A file edited again since was queued anew under a later turn: this answer must not label it.
    // The edits are dropped with it, unless the file changed again since: then they stay queued for that later turn.
    await update($, files, list => list.map(f => (byPath.get(f.path)?.why && f.editsTurn === byPath.get(f.path)?.turn ? { ...f, why: byPath.get(f.path)?.why, edits: undefined } : f)))
    await publish($)
  } finally {
    for (const path of paths) asking.delete(path)
  }
}

// Writes the page's data about once a second, only once /mission has opened it.
async function publish($: EngineInterface) {
  if (!page.on) return
  if (page.pending) {
    page.dirty = true // writing now: write once more when it is done
    return
  }
  page.pending = true
  page.dirty = false
  $.clock.after(400, () => {
    void (page.on ? writePage($) : Promise.resolve()) // /mission off may have come in meanwhile
      .catch(() => {})
      .finally(() => {
        page.pending = false
        if (page.dirty) void publish($).catch(() => {})
      })
  })
}

async function pageDir($: EngineInterface) {
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
  return `${tmp}/mission-control/${(await read($, sid)) || 'session'}`
}

// The page is one static file; data.js is all that changes.
async function writePage($: EngineInterface) {
  const dir = await pageDir($)
  const at = Date.now()
  const list = await read($, nodes)
  const data = {
    ...mapData(await read($, files), { at, turn: await read($, turn) }),
    who: { summary: summary(list), lines: lines(list, at).map(l => ({ prefix: l.prefix, text: l.text, status: l.status, kind: l.node.kind })) },
  }
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  if (json === page.last) return // nothing changed since the last write
  if (!page.written) {
    await $.fs.write(`${dir}/index.html`, TEMPLATE)
    page.written = true
  }
  await $.fs.write(`${dir}/data.js`, `window.MAP = ${json};`)
  page.last = json
}

// In a cmux split when this runs inside cmux, otherwise in the default browser.
async function openPage($: EngineInterface, tab: 'who' | 'code') {
  const url = `file://${encodeURI(await pageDir($))}/index.html#${tab}`
  const inCmux = Boolean(await $.env.get('CMUX_WORKSPACE_ID'))
  const argv = inCmux ? ['cmux', 'browser', 'open-split', url, '--focus', 'true'] : ['open', url]
  const r = await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => ({ exitCode: 1 }))
  return r.exitCode === 0 ? `Opened ${url}` : `Could not open a browser. Open ${url} yourself.`
}
