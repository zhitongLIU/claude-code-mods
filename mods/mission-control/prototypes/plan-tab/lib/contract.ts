// Parsers for what the Plan tab reads: an obeya_get_task_context result, and the `## Contract`
// header of a plan (docs/conventions/plan-contract.md in the planning repo). Plain text in, plain data out.

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

function field(text: string, labels: string[]) {
  for (const label of labels) {
    const m = new RegExp(`^- ${label}\\s*:\\s*(.+)$`, 'mi').exec(text)
    if (m) return m[1].trim()
  }
  return undefined
}

export function parseTaskContext(raw: string): TaskContext {
  const identity = untag(section(raw, /IDENTITY/))
  let plan = section(raw, /PLAN/)
  plan = untag(plan.split(/\n\*\*Block manifest/)[0]).trim()
  const children: Child[] = []
  // - **CAO-220** <untrusted …>\n<title>\n</untrusted-…> — done
  const re = /- \*\*([A-Z][A-Z0-9]+-\d+)\*\*[^\n]*\n([^\n]+)\n<\/untrusted[^>]*>\s*—\s*([\w-]+)/g
  for (const m of section(raw, /DECOMPOSITION/).matchAll(re)) children.push({ key: m[1], title: m[2].trim(), status: m[3] })
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
      const title = head[2].trim()
      const contract = /^Contract(?:\s+[—–-]\s+(\S+))?\s*$/i.exec(title)
      if (head[1] === '##') {
        inBlock = !!contract
        list = null
        if (contract) {
          found = true
          if (contract[1] && !out.service) out.service = contract[1]
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
    const service = /^\*\*Service:\*\*\s*(.+)$/i.exec(line.trim())
    if (service) {
      out.service = service[1].trim()
      continue
    }
    const blocked = /^\*\*Blocked by:\*\*\s*(.+)$/i.exec(line.trim())
    if (blocked) {
      for (const key of blocked[1].match(KEY) ?? []) out.blockedBy.push({ key, source: 'declared', evidence: line.trim() })
      continue
    }
    const item = /^\s*[-*]\s+`([^`]+)`(.*)$/.exec(line)
    if (item && list) {
      const rest = item[2]
      if (list === 'provides') {
        last = { id: item[1].trim(), delta: [] }
        out.provides.push(last)
      } else {
        const from = /\bfrom\s+([A-Z][A-Z0-9]+-\d+)/.exec(rest)
        last = { id: item[1].trim(), from: from ? from[1] : null, existing: /existing/i.test(rest), delta: [] }
        out.consumes.push(last)
      }
    }
  }
  return found ? out : undefined
}
