// Parsers for what the map reads: an obeya_get_task_context result, a local plan file, and the
// `## Contract` header of a plan (docs/conventions/plan-contract.md in the planning repo). Plain text in, plain data out.

export type Dep = { key: string; source: 'declared' | 'extracted' | 'inferred'; evidence: string }
export type Provide = { id: string; delta: string[]; evidence?: string }
export type Consume = { id: string; from: string | null; existing: boolean; delta: string[]; evidence?: string }
export type Contract = { service?: string; blockedBy: Dep[]; provides: Provide[]; consumes: Consume[] }
export type Child = { key: string; title: string; status: string }
export type TaskContext = { key?: string; title?: string; status?: string; branch?: string; plan: string; children: Child[] }

const KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g

// Obeya wraps stored text in <untrusted …> tags; the text itself is all the parser needs.
function untag(text: string) {
  return text.replace(/<\/?untrusted[^>]*>/g, '')
}

// The numbered sections of a task context: "## 1. IDENTITY", "## 3. PLAN", "## 4. DECOMPOSITION".
function section(text: string, name: RegExp) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => /^## \d+\. /.test(l) && name.test(l))
  if (start < 0) return ''
  const end = lines.findIndex((l, i) => i > start && /^## \d+\. /.test(l))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

// A regex group, '' when it did not match.
function g(m: RegExpExecArray | RegExpMatchArray | null | undefined, i: number) {
  return m?.[i] ?? ''
}

function field(text: string, labels: string[]) {
  for (const label of labels) {
    const m = new RegExp(`^- ${label}\\s*:\\s*(.+)$`, 'mi').exec(text)
    if (m) return g(m, 1).trim()
  }
  return undefined
}

export function parseTaskContext(raw: string): TaskContext {
  const identity = untag(section(raw, /IDENTITY/))
  const plan = untag(section(raw, /PLAN/).split(/\n\*\*Block manifest/)[0] ?? '').trim()
  const children: Child[] = []
  // - **CAO-220** <untrusted …>\n<title>\n</untrusted-…> — done
  const re = /- \*\*([A-Z][A-Z0-9]+-\d+)\*\*[^\n]*\n([^\n]+)\n<\/untrusted[^>]*>\s*—\s*([\w-]+)/g
  for (const m of section(raw, /DECOMPOSITION/).matchAll(re)) children.push({ key: g(m, 1), title: g(m, 2).trim(), status: g(m, 3) })
  return {
    key: field(identity, ['Clé', 'Key']),
    title: field(identity, ['Titre', 'Title']),
    status: field(identity, ['Statut', 'Status']),
    branch: field(identity, ['Branche', 'Branch']),
    plan,
    children,
  }
}

// The `## Contract` header of a plan, or undefined when the plan has none (an older plan).
// A plan spanning several services has one `## Contract — <service>` block each; they are merged.
export function parseContract(plan: string): Contract | undefined {
  const lines = plan.split('\n')
  const out: Contract = { blockedBy: [], provides: [], consumes: [] }
  let found = false
  let inBlock = false
  let list: 'provides' | 'consumes' | null = null
  let fence = false
  let last: Provide | Consume | null = null
  for (const line of lines) {
    const head = /^(#{2,3})\s+(.*)$/.exec(line)
    if (head && !fence) {
      const title = g(head, 2).trim()
      const contract = /^Contract(?:\s+[—–-]\s+(\S+))?\s*$/i.exec(title)
      if (g(head, 1) === '##') {
        inBlock = !!contract
        list = null
        if (contract) {
          found = true
          if (g(contract, 1) && !out.service) out.service = g(contract, 1)
        }
        continue
      }
      if (inBlock) list = /^provides$/i.test(title) ? 'provides' : /^consumes$/i.test(title) ? 'consumes' : null
      continue
    }
    if (!inBlock) continue
    if (/^\s*```/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) {
      const t = line.trim()
      if (last && /^[+~-]/.test(t)) last.delta.push(t)
      continue
    }
    // Obeya joins consecutive lines into one paragraph: **Service:** and **Blocked by:** may share a line.
    const service = /\*\*Service\s*:\*\*\s*([^*\s]+)/i.exec(line)
    const blocked = /\*\*Blocked by\s*:\*\*\s*([^*]+)/i.exec(line)
    if (service) out.service = g(service, 1).trim()
    if (blocked) for (const key of g(blocked, 1).match(KEY) ?? []) out.blockedBy.push({ key, source: 'declared', evidence: `Blocked by: ${g(blocked, 1).trim()}` })
    if (service || blocked) continue
    const item = /^\s*[-*]\s+`([^`]+)`(.*)$/.exec(line)
    if (item && list) {
      const rest = g(item, 2)
      if (list === 'provides') {
        const p: Provide = { id: g(item, 1).trim(), delta: [] }
        out.provides.push(p)
        last = p
      } else {
        const from = /\bfrom\s+([A-Z][A-Z0-9]+-\d+)/.exec(rest)
        const c: Consume = { id: g(item, 1).trim(), from: from ? g(from, 1) : null, existing: /existing/i.test(rest), delta: [] }
        out.consumes.push(c)
        last = c
      }
    }
  }
  return found ? out : undefined
}

export type LocalPlan = { id: string; title: string; status: string; service?: string; blockedBy: Dep[]; contract?: Contract }

// The `key: value` lines of a leading `---` block; lists written `[a, b]` come back as their text.
function frontmatter(text: string) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  const out: Record<string, string> = {}
  for (const line of g(m, 1).split('\n')) {
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line)
    if (kv) out[g(kv, 1).toLowerCase()] = g(kv, 2).trim()
  }
  return out
}

// A plan file on disk (.loop/tasks, .tasks, a speckit plan.md, any .md with a Contract header).
// Its id is the frontmatter `id`, else a ticket key in the file name, else the file name.
export function parseLocalPlan(path: string, text: string): LocalPlan {
  const fm = frontmatter(text)
  const name = path.split('/').pop() ?? path
  const id = fm.id || /[A-Z][A-Z0-9]+-\d+/.exec(name)?.[0] || name.replace(/\.md$/i, '')
  const title = g(/^#\s+(.+)$/m.exec(text.replace(/^---\n[\s\S]*?\n---/, '')), 1).trim() || name
  const contract = parseContract(text)
  const blocked = fm.blocked_by ?? ''
  const fromFm: Dep[] = blocked
    .replace(/[[\]]/g, '')
    .split(/[,\s]+/)
    .filter(k => k && !/^none$/i.test(k))
    .map(key => ({ key, source: 'declared' as const, evidence: `blocked_by: ${blocked}` }))
  return { id, title, status: fm.status || 'todo', service: contract?.service ?? fm.service, blockedBy: contract?.blockedBy.length ? contract.blockedBy : fromFm, contract }
}
