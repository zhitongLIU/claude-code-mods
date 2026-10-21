// Mission Control: /mission opens a live web page with two tabs for the current turn.
//   who  · the main loop, its subagents and every tool call they make, live
//   code · a map of the files Claude reads and edits, the imports between
//          them, a glow on what it touches right now, and one line on each change
// A band line sums it up while Claude works. The page re-reads data.js every second.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Finding, MapFile, MissionNode, MissionWhere } from '../types'
import { linksOf } from './lang'
import { SERVER, parseLine, portFor, splitLines } from './bridge'
import { addedDiff } from './diff'
import { byPath, merge, normalize, parseFindings, prRef, reviewPayload, splitByDiff } from './findings'
import { HLJS } from './vendor-hljs'
import { mapData } from './map'
import { TEMPLATE } from './template'
import { label, lines, summary } from './tree'

const MAX_NODES = 300
const MAX_FILES = 14
const DIFF_MAX = 200_000 // characters of one file's diff the page gets
const REVIEW_MAX = 40 // a review of a branch shows more files than a live turn does
const BAND_AFTER_MS = 30_000 // the band stays this long after a turn ends
// Tools that are Claude Code's own bookkeeping, not work: kept out of the tree.
const INTERNAL = new Set(['SubagentHandback', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])
// Files that belong on a code map: source, config and docs, not images or binaries.
export const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|vue|svelte|css|scss|html|md|mdx|json|ya?ml|toml|sh|sql|lua|ex|exs|erb|haml|slim)$/i

// A review also maps what a change touches around the code: env files, Dockerfiles, translations, lockfiles, schemas.
export const REVIEW_FILE = new RegExp(`${CODE_FILE.source}|(^|/)(\\.env[^/]*|Dockerfile[^/]*|Jenkinsfile|Gemfile(\\.lock)?|go\\.sum|yarn\\.lock|pnpm-lock\\.yaml|requirements[^/]*\\.txt)$|\\.(po|pot|xlf|xliff|ini|properties|tf|proto|graphql|gql|less|sass|lock)$`, 'i')

// Held by the host, so a hot reload keeps the picture.
const nodes = atom({ plugin: 'mission', key: 'nodes' } as const, [] as MissionNode[])
const files = atom({ plugin: 'mission', key: 'files' } as const, [] as MapFile[])
const turn = atom({ plugin: 'mission', key: 'turn' } as const, 0)
const diffs = atom({ plugin: 'mission', key: 'diffs' } as const, {} as Record<string, { text: string; ref?: string }>) // a changed file's diff, for the page's drawer
const where = atom({ plugin: 'mission', key: 'where' } as const, { branch: '' } as MissionWhere) // the branch and pull request the page is about
const findings = atom({ plugin: 'mission', key: 'findings' } as const, [] as Finding[]) // an AI review's findings, pink on the map; their index is their id
const sid = atom({ plugin: 'mission', key: 'sid' } as const, '') // this session's folder name, so sessions never share a page

// The web page's bookkeeping; a reload starts it over. `on` once /mission has opened the page.
const page = { on: false, pending: false, dirty: false, last: '', lastDiffs: '', written: false, posting: false, note: '' } // note: what the last push to the pull request came to
// The edits awaiting their one-line "why" live on the files atom (MapFile.edits), so a reload keeps
// them; the "why" is asked for lazily: no model call while nobody watches.
const asking = new Set<string>()
// The local server that serves the page and carries "Send to Claude" back; a reload ends it with the module.
const bridge: { base?: string; starting?: Promise<string | undefined>; stop: boolean } = { stop: false } // paths a model call is already explaining

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
    await $.command.register({ name: 'mission', description: 'Open the live web page of agents, tool calls and the code map; give a base, PR link or #123 to put what changed on the map first; off stops it', argumentHint: '[base | PR link | #123 | findings <file> | off]' }).catch(() => {})
    await $.tool.register({
      name: 'findings',
      description: 'Puts the findings of a code review on the Mission Control code map: each file with a finding turns pink and the finding shows under its line in the diff. Call it with the findings of any review, whoever wrote it. `add: true` keeps the findings already shown.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string', description: 'Repo-relative path' },
                line: { type: 'integer', description: '1-indexed line in the new version of the file; leave out for a finding on the whole file' },
                summary: { type: 'string', description: 'One sentence: the defect' },
                scenario: { type: 'string', description: 'Concrete inputs or state, then the wrong result' },
                severity: { type: 'string', description: 'e.g. high, medium, low, or a category' },
              },
              required: ['file', 'summary'],
            },
          },
          add: { type: 'boolean', description: 'Keep the findings already on the page instead of replacing them' },
        },
        required: ['findings'],
      },
    }).catch(() => {})
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
    await update($, files, list => list.map(f => (f.review ? { ...f, review: undefined } : f))) // a review is a one-time snapshot: the live map takes over
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

  // The findings tool, served here: the model hands over a review's findings and the page shows them.
  on('tool.call', { tool: 'mcp__mission__findings' }, async ($, e) => {
    const input = e as unknown as { findings?: unknown; add?: unknown }
    const got = normalize(input.findings)
    if (got.length === 0) return { result: 'No findings were given: each needs a file and a summary.' }
    const n = await setFindings($, got, input.add === true)
    return { result: `${got.length} findings on the Mission Control map (${n.onMap} on files shown there${n.off ? `, ${n.off} on files not on the map` : ''}). /mission opens the page.` }
  })

  // /code-review reports through ReportFindings: they go on the map without a word from the model.
  on('tool.call', { tool: 'ReportFindings' }, async ($, e, next) => {
    const r = await next(e)
    const got = normalize((e as unknown as { findings?: unknown }).findings)
    if (r.deny === undefined && r.isError !== true && got.length) await setFindings($, got, false).catch(() => {})
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
    if (isMain && page.on) {
      void explainPending($).catch(() => {}) // in the background, so the turn ends at once
      void refreshWhere($).catch(() => {})
    }
    return r
  })

  on('command.run', { command: 'mission' }, async ($, e) => run($, e.args))

  // The band: one summary line while Claude works, and for a short while after.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    const list = await read($, nodes)
    const main = list.find(n => n.kind === 'main')
    const s = summary(list)
    const isRecent = main !== undefined && (main.status === 'running' || Date.now() - (main.end ?? 0) < BAND_AFTER_MS)
    // While the page is served, its short address and the summary stay on the band: Cmd-click reopens a tab that was closed.
    const link = bridge.base ? `${bridge.base}/` : undefined
    const busy = (isRecent || link !== undefined) && s.tools + s.agents > 0
    if (e.props.hasSurvey || (!busy && !link)) return rest
    const t = await read($, turn)
    const edited = (await read($, files)).filter(f => f.changedTurn === t).length
    const { Box, Text, Link } = $.ui.resolve(e)
    const port = link ? /:(\d+)\//.exec(link)?.[1] : undefined
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color="blue" bold>{' ◈ mission: '}</Text>
          {busy ? <Text>{`${s.agents ? `${s.running}/${s.agents} agents · ` : ''}${s.tools} tools${s.failed ? ` · ${s.failed} failed` : ''}${edited ? ` · ${edited} files changed` : ''}`}</Text> : null}
          {link ? <Text dimColor>{busy ? '  ·  ' : ''}<Link href={link} label={`localhost:${port} ↗`} /></Text> : <Text dimColor>{'  ·  /mission'}</Text>}
        </Text>
        {rest}
      </Box>
    )
  })
}

// /mission [base | PR link | #123 | off]: opens the page (on the code map when it was given something to review),
// or stops it. `HEAD` reviews the uncommitted changes.
async function run($: EngineInterface, args: string) {
  const arg = args.trim()
  if (arg.toLowerCase() === 'off') {
    page.on = false
    bridge.stop = true // the server's read loop ends at its next beat, which ends the server
    bridge.base = undefined
    bridge.starting = undefined
    return { text: 'Mission Control: page stopped. /mission opens it again.' }
  }
  const fcmd = /^findings(?:\s+(.*))?$/i.exec(arg)
  if (fcmd) return loadFindings($, (fcmd[1] ?? '').trim())
  let note = ''
  let here: MissionWhere
  if (arg) {
    const r = await review($, arg)
    if ('error' in r) return { text: `Mission Control review: ${r.error}` }
    if (r.count === 0) return { text: `Mission Control review: no changed code files against ${r.ref}.` }
    note = `review: ${r.count} changed files against ${r.ref}. `
    here = r.where
  } else {
    here = await liveWhere($)
  }
  await update($, where, () => here)
  const s = summary(await read($, nodes))
  page.on = true
  await writePage($)
  const opened = await openPage($, arg ? 'code' : undefined, await startBridge($))
  void explainPending($).catch(() => {}) // the map is watched now: explain what changed while it was not
  return { text: `Mission Control: ${note}${s.agents} agents · ${s.tools} tool calls · ${(await read($, files)).length} files. ${opened}` }
}

// The page's branch and pull request, read again when a turn ends: a pull request opened (or a branch switched)
// since /mission ran shows up. A review's own base is left alone, and gh is asked only while there is no pull request.
async function refreshWhere($: EngineInterface) {
  const now = await read($, where)
  if (now.base || (now.branch && now.pr)) return
  const next = await liveWhere($)
  if (next.branch !== now.branch || next.pr?.number !== now.pr?.number) {
    await update($, where, () => next)
    await publish($)
  }
}

// A GitHub pull request named as a link or as #123: its number, and the repo when a link says which.
export function parsePr(arg: string) {
  const link = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(arg)
  if (link) return { repo: link[1] as string, number: link[2] as string }
  const num = /^#(\d+)$/.exec(arg)
  return num ? { repo: undefined, number: num[1] as string } : undefined
}

// Fills the code map from git once: the files changed against `base` (uncommitted changes when none), or the files of
// a pull request given as a link or #123, with their diffs queued for the one-line "why". Nothing watches git
// afterwards; the live map carries on from Claude's own edits.
export async function review($: EngineInterface, base: string) {
  const arg = base.trim()
  if (/^-/.test(arg)) return { error: `"${arg}" is not a branch, a commit or a pull request.` }
  const pr = parsePr(arg)
  if (pr?.repo) return reviewRemote($, pr.repo, pr.number) // a link names its repo: no clone needed
  const git = async (argv: string[]) => $.process.run(['git', ...argv], { timeoutMs: 60_000 }).catch(() => ({ exitCode: 1, stdout: '' }))
  const top = await git(['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return { error: 'this is not a git repository.' }
  const root = top.stdout.trim()

  // What the diff runs between, where a file's text comes from, and what to call it.
  let from = arg || 'HEAD'
  let to = '' // empty: the working tree
  let label = from
  let here: MissionWhere | undefined // set for a pull request; a plain base is looked at from the branch we are on
  if (pr) {
    const view = await $.process.run(['gh', 'pr', 'view', pr.number, '--json', 'baseRefName,headRefName,url'], { timeoutMs: 30_000 }).catch(() => ({ exitCode: 1, stdout: '' }))
    let baseRef: unknown
    let viewed: { baseRefName?: unknown; headRefName?: unknown; url?: unknown } = {}
    try {
      viewed = JSON.parse(view.stdout)
      baseRef = viewed.baseRefName
    } catch {}
    if (view.exitCode !== 0 || typeof baseRef !== 'string' || !/^[\w./-]+$/.test(baseRef) || baseRef.startsWith('-')) return { error: `gh could not read pull request #${pr.number} (is gh signed in?).` }
    // Fetched without making a branch or touching the working tree; the commits are named by their ids.
    if ((await git(['-C', root, 'fetch', '--quiet', 'origin', `pull/${pr.number}/head`])).exitCode !== 0) return { error: `git could not fetch pull request #${pr.number} from origin.` }
    to = (await git(['-C', root, 'rev-parse', 'FETCH_HEAD'])).stdout.trim()
    if ((await git(['-C', root, 'fetch', '--quiet', 'origin', baseRef])).exitCode !== 0) return { error: `git could not fetch ${baseRef} from origin.` }
    const baseSha = (await git(['-C', root, 'rev-parse', 'FETCH_HEAD'])).stdout.trim()
    from = (await git(['-C', root, 'merge-base', baseSha, to])).stdout.trim()
    if (!from || !to) return { error: `git could not find where pull request #${pr.number} branches off ${baseRef}.` }
    label = `PR #${pr.number} (${baseRef})`
    here = { branch: typeof viewed.headRefName === 'string' ? viewed.headRefName : `PR #${pr.number}`, base: baseRef, pr: prOf(Number(pr.number), viewed.url) }
  }

  const range = to ? [from, to] : [from]
  const changed = await git(['-C', root, 'diff', '--name-only', '-z', ...range, '--'])
  if (changed.exitCode !== 0) return { error: `git could not diff against "${arg || from}".` }
  const fresh = to ? { exitCode: 1, stdout: '' } : await git(['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'])
  const tracked = changed.stdout.split('\0').filter(Boolean)
  const untracked = fresh.exitCode === 0 ? fresh.stdout.split('\0').filter(Boolean) : []
  const paths = [...new Set([...tracked, ...untracked])].filter(p => REVIEW_FILE.test(p)).slice(0, REVIEW_MAX)
  const t = await read($, turn)
  const shown = new Map<string, { text: string; ref?: string }>()
  const found = await Promise.all(
    paths.map(async (rel): Promise<MapFile | undefined> => {
      const path = `${root}/${rel}`
      // A pull request's code is not on disk: read it from the fetched commit.
      const text = to ? (await git(['-C', root, 'show', `${to}:${rel}`])).stdout : await $.fs.read(path).catch(() => undefined)
      if (typeof text !== 'string' || (to && text === '')) return undefined // deleted since, or in the PR: nothing to map
      const links = linksOf(path, text.slice(0, 200_000))
      const d = tracked.includes(rel) ? await git(['-C', root, 'diff', '-U3', ...range, '--', rel]) : { exitCode: 0, stdout: '' }
      const body = d.stdout.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).join('\n').slice(0, 1500)
      shown.set(path, { text: (d.stdout || addedDiff(text)).slice(0, DIFF_MAX), ref: label })
      return { path, act: 'edit', at: Date.now() - 60_000, changedTurn: 0, review: true, imports: links.imports, names: links.names, edits: [body || `new file\n${text.slice(0, 400)}`], editsTurn: t } // a minute old: on the map as changed, not glowing as if Claude were editing it right now
    }),
  )
  return { count: await place($, found, shown), ref: label, where: here ?? { ...(await liveWhere($)), base: arg && arg !== 'HEAD' ? arg : undefined } }
}

// A pull request's number and link, when the link is one we would open.
function prOf(number: number, url: unknown): MissionWhere['pr'] {
  return typeof url === 'string' && /^https:\/\/\S+$/.test(url) ? { number, url } : undefined
}

// The branch we are on and its pull request, when there is one.
async function liveWhere($: EngineInterface): Promise<MissionWhere> {
  const git = async (argv: string[]) => $.process.run(['git', ...argv], { timeoutMs: 10_000 }).catch(() => ({ exitCode: 1, stdout: '' }))
  const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  let branch = b.exitCode === 0 ? b.stdout.trim() : ''
  if (branch === 'HEAD') {
    const sha = await git(['rev-parse', '--short', 'HEAD'])
    return { branch: sha.exitCode === 0 ? `detached at ${sha.stdout.trim()}` : '' } // no branch, so no pull request
  }
  if (!branch) return { branch: '' }
  const view = await $.process.run(['gh', 'pr', 'view', '--json', 'number,url'], { timeoutMs: 15_000 }).catch(() => ({ exitCode: 1, stdout: '' }))
  let pr: MissionWhere['pr']
  try {
    const v = JSON.parse(view.stdout) as { number?: unknown; url?: unknown }
    if (view.exitCode === 0 && typeof v.number === 'number') pr = prOf(v.number, v.url)
  } catch {}
  return { branch, pr }
}

// The files a review found go on the map, in front of what Claude touched; how many did.
async function place($: EngineInterface, found: (MapFile | undefined)[], shown: Map<string, { text: string; ref?: string }>) {
  const list = found.filter((f): f is MapFile => f !== undefined)
  await update($, diffs, old => ({ ...old, ...Object.fromEntries(list.flatMap(f => (shown.has(f.path) ? [[f.path, shown.get(f.path)]] : []))) }))
  await update($, files, old => [...list, ...old.filter(f => !f.review && !list.some(x => x.path === f.path))].slice(0, REVIEW_MAX))
  return list.length
}

// A pull request by its link, through GitHub alone: no clone, nothing fetched. The paths read /owner/repo/path.
async function reviewRemote($: EngineInterface, repo: string, number: string) {
  const gh = async (argv: string[]) => $.process.run(['gh', ...argv], { timeoutMs: 30_000 }).catch(() => ({ exitCode: 1, stdout: '' }))
  const meta = await gh(['api', `repos/${repo}/pulls/${number}`, '--jq', '{sha: .head.sha, base: .base.ref, head: .head.ref, url: .html_url}'])
  let head: { sha?: unknown; base?: unknown; head?: unknown; url?: unknown } = {}
  try {
    head = JSON.parse(meta.stdout)
  } catch {}
  if (meta.exitCode !== 0 || typeof head.sha !== 'string' || !/^[0-9a-f]{40}$/.test(head.sha)) return { error: `gh could not read ${repo} pull request #${number} (is gh signed in, and can it see that repo?).` }
  const sha = head.sha
  const listed = await gh(['api', `repos/${repo}/pulls/${number}/files?per_page=100`, '--jq', '.[] | {filename, status, patch}'])
  if (listed.exitCode !== 0) return { error: `gh could not list the files of ${repo} pull request #${number}.` }
  const rows = listed.stdout.split('\n').flatMap(line => {
    try {
      const f = JSON.parse(line) as { filename?: unknown; status?: unknown; patch?: unknown }
      return typeof f.filename === 'string' && f.status !== 'removed' && REVIEW_FILE.test(f.filename) ? [{ name: f.filename, patch: typeof f.patch === 'string' ? f.patch : '' }] : []
    } catch {
      return []
    }
  })
  const t = await read($, turn)
  const ref = `PR #${number} (${head.base}) ${repo}@${sha.slice(0, 7)}`
  const shown = new Map<string, { text: string; ref?: string }>()
  const found = await Promise.all(
    rows.slice(0, REVIEW_MAX).map(async ({ name, patch }): Promise<MapFile | undefined> => {
      const path = `/${repo}/${name}`
      const raw = await gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${name.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`])
      const text = raw.exitCode === 0 ? raw.stdout : ''
      const links = linksOf(path, text.slice(0, 200_000))
      const body = patch.split('\n').filter(l => /^[+-]/.test(l)).join('\n').slice(0, 1500) // a patch has no file headers: only hunk and +/- lines
      shown.set(path, { text: patch.slice(0, DIFF_MAX), ref }) // GitHub sends no patch for a very large or binary file: the drawer says so
      return { path, act: 'edit', at: Date.now() - 60_000, changedTurn: 0, review: true, imports: links.imports, names: links.names, edits: [body || `changed ${name}`], editsTurn: t }
    }),
  )
  const here: MissionWhere = { branch: typeof head.head === 'string' ? head.head : `PR #${number}`, base: typeof head.base === 'string' ? head.base : undefined, pr: prOf(Number(number), head.url) }
  return { count: await place($, found, shown), ref: `PR #${number} (${head.base})`, where: here }
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
  if (isChange) await liveDiff($, path, typeof text === 'string' ? text : '')
  await publish($)
  $.clock.after(5500, () => void publish($).catch(() => {})) // again once the glow has faded
}

// What a file Claude just changed looks like against HEAD, for the page's drawer. Nothing when git cannot say.
async function liveDiff($: EngineInterface, path: string, text: string) {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/'
  const git = async (argv: string[]) => $.process.run(['git', '-C', dir, ...argv], { timeoutMs: 10_000 }).catch(() => ({ exitCode: 1, stdout: '' }))
  const d = await git(['diff', 'HEAD', '--no-color', '-U3', '--', path])
  if (d.exitCode !== 0) return
  const known = d.stdout !== '' || (await git(['ls-files', '--error-unmatch', '--', path])).exitCode === 0
  const body = d.stdout || (known ? '' : addedDiff(text)) // a new file git does not know yet reads as all added
  await update($, diffs, old => {
    const { [path]: _, ...rest } = old
    return body ? { ...rest, [path]: { text: body.slice(0, DIFF_MAX) } } : rest
  })
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

// Puts a review's findings on the page; how many sit on files the map shows.
async function setFindings($: EngineInterface, got: Finding[], add: boolean) {
  await update($, findings, old => merge(old, got, add))
  page.note = ''
  const all = await read($, findings)
  const { matched, unmatched } = byPath(all, (await read($, files)).map(f => f.path))
  await publish($)
  return { onMap: all.length - unmatched, off: unmatched, files: Object.keys(matched).length }
}

// /mission findings <file>: findings from a JSON file; `clear` takes them off; with nothing, says what is shown.
async function loadFindings($: EngineInterface, arg: string) {
  if (arg === 'clear') {
    await update($, findings, () => [])
    await publish($)
    return { text: 'Mission Control: findings cleared.' }
  }
  if (!arg) return { text: `Mission Control: ${(await read($, findings)).length} findings on the page. /mission findings <file.json> loads more; /mission findings clear removes them.` }
  const add = /(^|\s)--add$/.test(arg)
  const path = arg.replace(/\s*--add$/, '')
  const raw = await $.fs.read(path).catch(() => undefined)
  if (typeof raw !== 'string') return { text: `Mission Control: could not read ${path}.` }
  const got = parseFindings(raw)
  if (got.length === 0) return { text: `Mission Control: no findings in ${path}: expected a JSON array of { file, line?, summary, scenario? }.` }
  const n = await setFindings($, got, add)
  return { text: `Mission Control: ${got.length} findings loaded, ${n.onMap} on files the map shows${n.off ? `, ${n.off} on files that are not on it` : ''}. /mission opens the page.` }
}

// Pushes the findings the reviewer picked on the page to the pull request as one review of comments.
// The page sends ids only: what is posted is what is held here.
async function postFindings($: EngineInterface, ids: number[]) {
  if (page.posting) return
  page.posting = true
  try {
    const all = await read($, findings)
    const chosen = [...new Set(ids)].flatMap(i => (all[i] && !all[i].posted ? [{ i, f: all[i] }] : []))
    const pr = prRef((await read($, where)).pr?.url)
    if (!pr) page.note = 'Could not post: this page is not about a pull request.'
    else if (chosen.length === 0) page.note = 'Nothing to post: those findings were already pushed.'
    else {
      const gh = async (argv: string[]) => $.process.run(['gh', ...argv], { timeoutMs: 30_000 }).catch(() => ({ exitCode: 1, stdout: '' }))
      const sha = (await gh(['api', `repos/${pr.repo}/pulls/${pr.number}`, '--jq', '.head.sha'])).stdout.trim()
      if (!/^[0-9a-f]{40}$/.test(sha)) page.note = `Could not post: gh could not read ${pr.repo} #${pr.number} (is gh signed in?).`
      else {
        // A comment on a line outside the diff makes GitHub refuse the whole review: those go in the review's text.
        const listed = await gh(['api', `repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`, '--paginate', '--jq', '.[] | {filename, patch}'])
        const patches: Record<string, string> = {}
        for (const line of listed.stdout.split('\n')) {
          try {
            const f = JSON.parse(line) as { filename?: unknown; patch?: unknown }
            if (typeof f.filename === 'string') patches[f.filename] = typeof f.patch === 'string' ? f.patch : ''
          } catch {}
        }
        const { inline, rest } = splitByDiff(chosen.map(c => c.f), patches)
        const file = `${await pageDir($)}/review.json`
        await $.fs.write(file, JSON.stringify(reviewPayload(inline, rest, sha)))
        const r = (await $.process.run(['gh', 'api', '-X', 'POST', `repos/${pr.repo}/pulls/${pr.number}/reviews`, '--input', file], { timeoutMs: 30_000 }).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))) as { exitCode: number; stdout: string; stderr?: string }
        if (r.exitCode === 0) {
          const done = new Set(chosen.map(c => c.i))
          await update($, findings, old => old.map((f, i) => (done.has(i) ? { ...f, posted: true } : f)))
          page.note = `Posted ${chosen.length} finding${chosen.length === 1 ? '' : 's'} to ${pr.repo} #${pr.number}${rest.length ? ` (${rest.length} in the review text: not on a line of the diff)` : ''}.`
        } else {
          const why = `${r.stderr ?? ''} ${r.stdout}`.replace(/\s+/g, ' ').trim().slice(0, 160)
          page.note = `Could not post, nothing was posted: ${why || 'GitHub refused the review (no permission?)'}`
        }
      }
    }
  } finally {
    page.posting = false
    await publish($)
  }
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
  const all0 = await read($, findings)
  const { matched } = byPath(all0, (await read($, files)).map(f => f.path))
  const flagged = Object.fromEntries(Object.entries(matched).map(([p, fs]) => [p, fs.filter(f => !f.posted).length || fs.length]))
  const shown = Object.fromEntries(Object.entries(matched).map(([p, fs]) => [p, fs.map(f => ({ id: all0.indexOf(f), file: f.file, line: f.line, summary: f.summary, scenario: f.scenario, severity: f.severity, posted: f.posted === true }))]))
  const data = {
    ...mapData(await read($, files), { at, turn: await read($, turn) }, flagged),
    who: { summary: summary(list), lines: lines(list, at).map(l => ({ prefix: l.prefix, text: l.text, status: l.status, kind: l.node.kind })) },
  }
  // The diffs of the files on the map. The page loads diffs.js when `rev` changes, so data.js stays small.
  const onMap = new Set((await read($, files)).map(f => f.path))
  const all = Object.fromEntries(Object.entries(await read($, diffs)).filter(([p]) => onMap.has(p)))
  const diffJson = JSON.stringify(all).replace(/</g, '\\u003c')
  const rev = [...diffJson].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7)
  const here = await read($, where)
  const json = JSON.stringify({ ...data, where: here.branch ? here : undefined, findings: shown, post: { can: Boolean(prRef(here.pr?.url)), note: page.note }, diffs: { rev, paths: Object.keys(all) } }).replace(/</g, '\\u003c')
  if (json === page.last) return // nothing changed since the last write
  if (!page.written) {
    await $.fs.write(`${dir}/index.html`, TEMPLATE)
    await $.fs.write(`${dir}/hljs.js`, HLJS) // highlight.js, for the diff drawer; the page copes without it
    page.written = true
  }
  if (diffJson !== page.lastDiffs) {
    await $.fs.write(`${dir}/diffs.js`, `window.DIFFS = ${diffJson};`) // before data.js, which tells the page it changed
    page.lastDiffs = diffJson
  }
  await $.fs.write(`${dir}/data.js`, `window.MAP = ${json};`)
  page.last = json
}

// The workspace cmux has in focus, or undefined when it cannot say (the split then goes where cmux would send it).
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

// Starts the page's local server once; resolves its address, or undefined where Node is missing or it does not come up
// (the page then opens from disk and keeps its clipboard buttons). A line the page sent is submitted as a prompt.
function startBridge($: EngineInterface): Promise<string | undefined> {
  if (bridge.base) return Promise.resolve(bridge.base)
  bridge.starting ??= new Promise<string | undefined>(resolve => {
    bridge.stop = false
    $.clock.after(4000, () => resolve(undefined))
    void (async () => {
      const dir = await pageDir($)
      await $.fs.write(`${dir}/server.mjs`, SERVER)
      let rest = ''
      for await (const piece of $.process.spawn({ argv: ['node', `${dir}/server.mjs`, dir, String(portFor((await read($, sid)) || 'session'))] })) {
        if (bridge.stop) break // leaving the loop ends the child
        const { stream, text } = piece as { stream?: string; text?: string }
        if (stream !== 'stdout' || text === undefined) continue
        const got = splitLines(rest, text)
        rest = got.rest
        for (const line of got.done) {
          const msg = parseLine(line)
          if (msg && 'ready' in msg) {
            bridge.base = `http://127.0.0.1:${msg.port}/${msg.token}`
            resolve(bridge.base)
          } else if (msg && 'send' in msg) void $.prompt.submit({ text: msg.send }).catch(() => {})
          else if (msg && 'post' in msg) void postFindings($, msg.post).catch(() => {})
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        bridge.base = undefined
        bridge.starting = undefined
        resolve(undefined)
      })
  })
  return bridge.starting
}

// In a cmux split when this runs inside cmux, otherwise in the default browser.
// Without a tab the page opens on the one the person used last.
async function openPage($: EngineInterface, tab?: 'code', base?: string) {
  const url = `${base ? `${base}/` : `file://${encodeURI(await pageDir($))}/index.html`}${tab ? `#${tab}` : ''}`
  const inCmux = Boolean(await $.env.get('CMUX_WORKSPACE_ID'))
  // cmux splits go to $CMUX_WORKSPACE_ID, fixed when Claude Code started: stale once the tab moved or the
  // session was resumed elsewhere. The workspace in focus is the one the person just typed /mission in.
  const workspace = inCmux ? await focusedWorkspace($) : undefined
  const argv = inCmux ? ['cmux', 'browser', 'open-split', url, '--focus', 'true', ...(workspace ? ['--workspace', workspace] : [])] : ['open', url]
  const r = await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => ({ exitCode: 1 }))
  return r.exitCode === 0 ? `Opened ${url}` : `Could not open a browser. Open ${url} yourself.`
}
