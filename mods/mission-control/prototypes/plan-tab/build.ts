// Builds data.js for the Plan tab (index.html) from disk, with no model call:
//   1. the Obeya contexts capture.ts saved (the epic and each sub-ticket),
//   2. each plan's `## Contract` header, parsed,
//   3. extracted/<EPIC>.json for plans written before the convention (contracts a model read from prose once),
//   4. pull requests from `gh`, matched on the ticket key in the branch name.
// Usage: node build.ts CAO-219 [--out data.js] [--org acme]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseContract, parseTaskContext } from './lib/contract.ts'
import type { Consume, Dep, Provide, TaskContext } from './lib/contract.ts'

type PR = { repo: string; number: number; state: string; url: string }
type Extracted = { aliases?: Record<string, string>; serviceOrder?: string[]; tickets?: ExtractedTicket[] }
type ExtractedTicket = { key: string; service?: string; blockedBy?: Dep[]; provides?: Provide[]; consumes?: Consume[]; files?: string[] }

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE = process.env.MISSION_PLAN_CACHE ?? join(homedir(), '.cache', 'mission-plan', 'obeya')
const TICKET_URL = 'https://obeya.example.com/tasks/{key}'

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function cached(key: string): { ctx: TaskContext; at: number } | undefined {
  const path = join(CACHE, `${key}.md`)
  if (!existsSync(path)) return undefined
  return { ctx: parseTaskContext(readFileSync(path, 'utf8')), at: statSync(path).mtimeMs }
}

// Every pull request of a repo, once per run; a repo gh cannot read gives none.
const prCache = new Map<string, { headRefName: string; title: string; number: number; state: string; isDraft: boolean; url: string }[]>()
function prsOf(org: string, repo: string) {
  if (!prCache.has(repo)) {
    try {
      const out = execFileSync('gh', ['pr', 'list', '-R', `${org}/${repo}`, '--state', 'all', '--limit', '300', '--json', 'headRefName,title,number,state,isDraft,url'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] })
      prCache.set(repo, JSON.parse(out))
    } catch {
      prCache.set(repo, [])
    }
  }
  return prCache.get(repo) ?? []
}

function prsFor(org: string, repo: string, key: string, branch?: string): PR[] {
  const k = key.toLowerCase()
  return prsOf(org, repo)
    .filter(p => p.headRefName === branch || p.headRefName.toLowerCase().startsWith(`${k}-`) || new RegExp(`\\b${key}\\b`).test(p.title))
    .map(p => ({ repo, number: p.number, state: p.isDraft ? 'draft' : p.state.toLowerCase(), url: p.url }))
}

function main() {
  const epic = process.argv[2]
  if (!epic || !/^[A-Z][A-Z0-9]+-\d+$/.test(epic)) throw new Error('usage: node build.ts <EPIC-KEY> [--out data.js] [--org acme]')
  const org = arg('org', 'acme')
  const outPath = arg('out', join(HERE, 'data.js'))
  const root = cached(epic)
  if (!root) throw new Error(`No cached context for ${epic} in ${CACHE}. Ask Claude to read it with obeya_get_task_context (for: implement); the capture hook saves it.`)
  const extractedPath = join(HERE, 'extracted', `${epic}.json`)
  const extracted: Extracted = existsSync(extractedPath) ? JSON.parse(readFileSync(extractedPath, 'utf8')) : {}
  const legacy = new Map((extracted.tickets ?? []).map(t => [t.key, t]))

  const missing: string[] = []
  const tickets = root.ctx.children.map(child => {
    const own = cached(child.key)
    if (!own) missing.push(child.key)
    const contract = own ? parseContract(own.ctx.plan) : undefined
    const old = legacy.get(child.key)
    // whichever capture is newer knows the status better: the ticket's own, or the epic's list of children
    const status = own && own.at > root.at ? own.ctx.status ?? child.status : child.status
    const title = own?.ctx.title ?? child.title
    const service = contract?.service ?? old?.service ?? /^\[([^\]]+)\]/.exec(title)?.[1] ?? 'other'
    return {
      key: child.key,
      title,
      status,
      service,
      contractSource: contract ? 'header' : old ? 'extracted' : 'none',
      blockedBy: contract ? contract.blockedBy : old?.blockedBy ?? [],
      provides: contract ? contract.provides : old?.provides ?? [],
      consumes: contract ? contract.consumes : old?.consumes ?? [],
      files: old?.files ?? [],
      prs: prsFor(org, service, child.key, own?.ctx.branch),
    }
  })

  const plan = {
    epic: { key: epic, title: root.ctx.title ?? epic },
    ticketUrl: TICKET_URL,
    builtAt: new Date().toISOString(),
    aliases: extracted.aliases ?? {},
    serviceOrder: extracted.serviceOrder ?? [],
    tickets,
  }
  writeFileSync(outPath, `window.PLAN = ${JSON.stringify(plan, null, 2)}\n`)
  const headers = tickets.filter(t => t.contractSource === 'header').length
  console.log(`${outPath}: ${tickets.length} tickets (${headers} with a Contract header, ${tickets.length - headers} from extracted/none), ${tickets.reduce((n, t) => n + t.prs.length, 0)} PRs`)
  if (missing.length) console.log(`no cached context for ${missing.join(', ')}: titles and statuses come from ${epic}'s list; read them once to pick up their Contract headers`)
}

main()
