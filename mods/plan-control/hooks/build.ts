// What the page draws, as plain data, from what the mod holds: the map's sources, the cached Obeya contexts,
// the local plan files, contracts extracted once from older plans, and pull requests. No I/O here.
import { parseContract, parseLocalPlan, parseTaskContext } from './contract'
import type { Consume, Dep, Provide, TaskContext } from './contract'

export const TICKET_URL = 'https://obeya.example.com/tasks/{key}'
export const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/

// One thing the person added: an Obeya ticket (with its sub-tickets unless `children` is false) or a plan file.
export type Source = { ref: string; kind: 'obeya' | 'file'; children?: boolean; addedAt: string }

export type MapFile = {
  title: string
  cwd: string
  updatedAt: string
  sources: Source[]
  excluded: string[] // sub-tickets taken off the map while their parent stays
  positions: Record<string, { x: number; y: number }>
  movedTo?: string // the session that attached this map
}

export type ExtractedTicket = { key: string; service?: string; blockedBy?: Dep[]; provides?: Provide[]; consumes?: Consume[]; files?: string[] }
export type Extracted = { aliases?: Record<string, string>; serviceOrder?: string[]; tickets?: ExtractedTicket[] }
export type PrRow = { headRefName: string; title: string; number: number; state: string; isDraft: boolean; url: string }
export type PR = { repo: string; number: number; state: string; url: string }

export type Ticket = {
  key: string
  kind: 'obeya' | 'file'
  title: string
  status: string // Obeya's status, a file's frontmatter status, or 'loading' while Claude has not read it yet
  service: string
  url?: string
  path?: string
  parent?: string
  contractSource: 'header' | 'extracted' | 'none'
  blockedBy: Dep[]
  provides: Provide[]
  consumes: Checked[]
  files: string[]
  prs: PR[]
}

// How a consumed interface compares with what its provider declares.
export type Check = {
  missing: string[] // fields the consumer reads that the provider neither adds nor changes
  removed: string[] // of those, the ones the provider removes
  noProvider: boolean // the provider lists no interface with this id
  unchecked: boolean // the provider lists the interface with no field lines: nothing to compare
  suggestion?: string // the provider's closest interface id, when this one matches none
}
// A consumed interface with its check against each provider on the map (by ticket key): the declared one
// (`from`), or the tickets providing the same id. `(existing, unchanged)` entries are never checked.
export type Checked = Consume & { checks?: Record<string, Check> }

export type PlanData = {
  title: string
  epics: { key: string; title: string; url: string }[]
  ticketUrl: string
  aliases: Record<string, string>
  serviceOrder: string[]
  tickets: Ticket[]
  missing: string[] // Obeya keys on the map that no cached context covers yet
  positions: MapFile['positions'] // boxes the person dragged, by ticket key
}

export type BuildInput = {
  map: MapFile
  contexts: Record<string, { text: string; at: number }>
  files: Record<string, string> // a plan file's path → its text
  extracted: Extracted[]
  prs: Record<string, PrRow[]> // repo → its pull requests
  ticketUrl?: string // where a ticket key opens, `{key}` replaced; TICKET_URL when unset
}

export function emptyMap(cwd: string): MapFile {
  return { title: '', cwd, updatedAt: new Date().toISOString(), sources: [], excluded: [], positions: {} }
}

// A pull request belongs to a ticket when its branch is the ticket's, starts with the key, or its title names the key.
export function prsFor(rows: PrRow[], repo: string, key: string, branch?: string): PR[] {
  const k = key.toLowerCase()
  const named = new RegExp(`\\b${key}\\b`)
  return rows
    .filter(p => p.headRefName === branch || p.headRefName.toLowerCase().startsWith(`${k}-`) || named.test(p.title))
    .map(p => ({ repo, number: p.number, state: p.isDraft ? 'draft' : p.state.toLowerCase(), url: p.url }))
}

function serviceOf(title: string) {
  return /^\[([^\]]+)\]/.exec(title)?.[1]
}

export function buildPlan(input: BuildInput): PlanData {
  const { map, contexts, files, prs } = input
  const ticketUrl = input.ticketUrl || TICKET_URL
  const ctx = new Map<string, { c: TaskContext; at: number }>()
  for (const [key, v] of Object.entries(contexts)) ctx.set(key, { c: parseTaskContext(v.text), at: v.at })
  const legacy = new Map<string, ExtractedTicket>()
  const aliases: Record<string, string> = {}
  const order: string[] = []
  for (const x of input.extracted) {
    for (const t of x.tickets ?? []) legacy.set(t.key, t)
    Object.assign(aliases, x.aliases ?? {})
    for (const s of x.serviceOrder ?? []) if (!order.includes(s)) order.push(s)
  }
  const excluded = new Set(map.excluded)
  const tickets = new Map<string, Ticket>()
  const epics: PlanData['epics'] = []
  const missing: string[] = []

  const obeya = (key: string, parent?: { key: string; at: number; title: string; status: string }) => {
    if (tickets.has(key) || excluded.has(key)) return
    const own = ctx.get(key)
    if (!own && !parent) missing.push(key)
    const c = own?.c
    const contract = c ? parseContract(c.plan) : undefined
    const old = legacy.get(key)
    // whichever read is newer knows the status better: the ticket's own, or its parent's list of sub-tickets
    const status = own && (!parent || own.at > parent.at) ? (c?.status ?? parent?.status ?? 'loading') : (parent?.status ?? 'loading')
    const title = c?.title ?? parent?.title ?? key
    const service = contract?.service ?? old?.service ?? serviceOf(title) ?? 'other'
    tickets.set(key, {
      key,
      kind: 'obeya',
      title,
      status,
      service,
      url: ticketUrl.replace('{key}', key),
      parent: parent?.key,
      contractSource: contract ? 'header' : old ? 'extracted' : 'none',
      blockedBy: contract ? contract.blockedBy : (old?.blockedBy ?? []),
      provides: contract ? contract.provides : (old?.provides ?? []),
      consumes: contract ? contract.consumes : (old?.consumes ?? []),
      files: old?.files ?? [],
      prs: prsFor(prs[service] ?? [], service, key, c?.branch),
    })
  }

  for (const s of map.sources) {
    if (s.kind === 'file') {
      const text = files[s.ref]
      if (text === undefined) continue
      const p = parseLocalPlan(s.ref, text)
      if (tickets.has(p.id) || excluded.has(p.id)) continue
      const service = p.service ?? 'other'
      tickets.set(p.id, {
        key: p.id,
        kind: 'file',
        title: p.title,
        status: p.status,
        service,
        path: s.ref,
        url: `vscode://file${encodeURI(s.ref)}`,
        contractSource: p.contract ? 'header' : 'none',
        blockedBy: p.blockedBy,
        provides: p.contract?.provides ?? [],
        consumes: p.contract?.consumes ?? [],
        files: [],
        prs: KEY_RE.test(p.id) ? prsFor(prs[service] ?? [], service, p.id) : [],
      })
      continue
    }
    const own = ctx.get(s.ref)
    const kids = own?.c.children ?? []
    if (s.children !== false && kids.length) {
      epics.push({ key: s.ref, title: own?.c.title ?? s.ref, url: ticketUrl.replace('{key}', s.ref) })
      for (const k of kids) obeya(k.key, { key: s.ref, at: own?.at ?? 0, title: k.title, status: k.status })
    } else obeya(s.ref)
  }

  const list = [...tickets.values()]
  attachChecks(list, aliases)
  return {
    title: map.title || epics[0]?.title || [...tickets.values()][0]?.title || 'Plan',
    epics,
    ticketUrl,
    aliases,
    serviceOrder: order,
    tickets: list,
    missing,
    positions: map.positions ?? {},
  }
}

// What `/plan-control add` was given: Obeya keys (an Obeya link counts as its key) and paths, `--only` for a parent alone.
export function parseRefs(args: string): { keys: string[]; paths: string[]; only: boolean } {
  const words = args.split(/\s+/).filter(Boolean)
  const only = words.includes('--only')
  const keys: string[] = []
  const paths: string[] = []
  for (const w of words) {
    if (w === '--only') continue
    const link = /\/tasks\/([A-Z][A-Z0-9]+-\d+)\b/.exec(w)
    const key = link ? link[1] : KEY_RE.test(w.toUpperCase()) && !w.includes('/') && !w.endsWith('.md') ? w.toUpperCase() : undefined
    if (key) keys.push(key)
    else paths.push(w)
  }
  return { keys, paths, only }
}

// The field a delta line is about: "+ deferred_payment.verification_state: enum" → deferred_payment.verification_state.
// A leading section word ("header X-Token", "response 200 x") is dropped: context lines such as `header:` say the same.
export function fieldOf(line: string) {
  const m = /^[+~-]\s*(?:(?:header|body|query|param|payload|request|response(?:\s+\d+)?)[\s.]+)?([^:#\s,(]+)/i.exec(line.trim())
  return m?.[1]
}

// Two field paths name the same field when equal, or when one ends the other at a dot: `order.x` and `x`.
export function sameField(a: string, b: string) {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

// The provider's interface id closest to `id`: same kind, most shared path pieces (at least two).
function closest(id: string, ids: string[]) {
  const parts = (x: string) => new Set(x.split(/[\s/]+/).filter(Boolean))
  const want = parts(id)
  let best: string | undefined
  let score = 1
  for (const x of ids) {
    if (x.split(' ')[0] !== id.split(' ')[0]) continue
    const n = [...parts(x)].filter(p => want.has(p)).length
    if (n > score) [best, score] = [x, n]
  }
  return best
}

// What `from` declares for the interface `c` consumes, field by field.
export function checkConsume(c: Consume, from: Ticket): Check {
  const prov = from.provides.find(p => p.id === c.id)
  if (!prov) return { missing: [], removed: [], noProvider: true, unchecked: false, suggestion: closest(c.id, from.provides.map(p => p.id)) }
  if (!prov.delta.length) return { missing: [], removed: [], noProvider: false, unchecked: true }
  const given = prov.delta.filter(l => !l.trim().startsWith('-')).map(fieldOf).filter((f): f is string => !!f)
  const gone = prov.delta.filter(l => l.trim().startsWith('-')).map(fieldOf).filter((f): f is string => !!f)
  const missing: string[] = []
  const removed: string[] = []
  for (const f of c.delta.map(fieldOf)) {
    if (!f) continue
    if (gone.some(g => sameField(g, f))) {
      removed.push(f)
      missing.push(f)
    } else if (!given.some(g => sameField(g, f))) missing.push(f)
  }
  return { missing, removed, noProvider: false, unchecked: false }
}

// Puts each consumed interface's checks on it. A provider not on the map, or not read yet, is not checked.
export function attachChecks(tickets: Ticket[], aliases: Record<string, string>) {
  const real = (k: string) => aliases[k] ?? k
  const byKey = new Map(tickets.map(t => [t.key, t]))
  const providers = new Map<string, string[]>()
  for (const t of tickets) for (const p of t.provides) providers.set(p.id, [...(providers.get(p.id) ?? []), t.key])
  for (const t of tickets) {
    t.consumes = t.consumes.map(c => {
      if (c.existing) return { ...c, checks: {} }
      const froms = c.from ? [real(c.from)] : (providers.get(c.id) ?? []).filter(k => k !== t.key)
      const checks: Record<string, Check> = {}
      for (const k of froms) {
        const from = byKey.get(k)
        if (from && from.status !== 'loading') checks[k] = checkConsume(c, from)
      }
      return { ...c, checks }
    })
  }
}

// The counts the band shows; mismatches as the page counts them, from the same checks.
export function summarize(data: PlanData) {
  const real = (k: string) => data.aliases[k] ?? k
  const byKey = new Map(data.tickets.map(t => [t.key, t]))
  let mismatches = 0
  for (const t of data.tickets) for (const c of t.consumes) for (const ch of Object.values(c.checks ?? {})) mismatches += ch.noProvider ? 1 : ch.missing.length
  const blockersDone = (t: Ticket) => t.blockedBy.every(b => byKey.get(real(b.key))?.status === 'done')
  return {
    title: data.title,
    tickets: data.tickets.length,
    done: data.tickets.filter(t => t.status === 'done').length,
    ready: data.tickets.filter(t => t.status !== 'done' && t.status !== 'loading' && blockersDone(t)).length,
    reading: data.tickets.filter(t => t.status === 'loading').length,
    mismatches,
  }
}
