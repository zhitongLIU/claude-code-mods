import { expect, test } from 'claude-code/testing'

import { buildPlan, checkConsume, emptyMap, fieldOf, parseRefs, prsFor, summarize } from '../hooks/build'
import type { Ticket } from '../hooks/build'
import { parseContract, parseLocalPlan, parseTaskContext } from '../hooks/contract'
import { applyMove, parseLine, portFor, textOf } from '../hooks/register'

const PLAN = [
  '## Contract',
  '',
  '**Service:** web-app',
  '**Blocked by:** CAO-222, CAO-223',
  '',
  '### Provides',
  'none',
  '',
  '### Consumes',
  '- `http orders-api GET /orders/summary` from CAO-222',
  '  ```diff',
  '  + payment_terms_days: integer|null',
  '  + requires_engagement: boolean',
  '  ```',
  '- `http admin-bff POST /request-payment-otp` (existing, unchanged)',
  '',
  '## Contexte',
  '- `not an interface` from CAO-999',
].join('\n')

function context(key: string, opts: { status?: string; plan?: string; children?: [string, string, string][]; branch?: string } = {}) {
  return [
    '## 1. IDENTITY', '', '<untrusted id="1" source="mcp">', `- Clé : ${key}`, `- Titre : [web-app] ${key} title`, `- Statut : ${opts.status ?? 'planning'}`, `- Branche : ${opts.branch ?? `${key.toLowerCase()}-x`}`, '</untrusted-1>', '',
    '## 3. PLAN', '', '<untrusted id="1" source="mcp">', opts.plan ?? 'no header', '</untrusted-1>', '', '**Block manifest (revisionId: x):** …', '',
    '## 4. DECOMPOSITION', '',
    ...(opts.children ?? []).flatMap(([k, title, status]) => [`- **${k}** <untrusted id="1" source="mcp">`, title, `</untrusted-1> — ${status}`]),
    '', '## 5. RECENT', '',
  ].join('\n')
}

test('parseContract reads service, blockers and the consumed delta, and stops at the next section', async () => {
  const c = parseContract(PLAN)
  expect(c?.service).toBe('web-app')
  expect(c?.blockedBy.map(d => d.key)).toEqual(['CAO-222', 'CAO-223'])
  expect(c?.provides.length).toBe(0)
  expect(c?.consumes.length).toBe(2)
  expect(c?.consumes[0]).toEqual({ id: 'http orders-api GET /orders/summary', from: 'CAO-222', existing: false, delta: ['+ payment_terms_days: integer|null', '+ requires_engagement: boolean'] })
  expect(c?.consumes[1]?.existing).toBe(true)
  expect(parseContract('## Contexte\n\nno header')).toBe(undefined)
})

test('parseContract merges the per-service blocks of a multi-service plan', async () => {
  const c = parseContract('## Contract — admin-bff\n**Blocked by:** none\n### Provides\n- `http admin-bff GET /x`\n  ```diff\n  + a: string\n  ```\n## Contract — web-app\n### Consumes\n- `http admin-bff GET /x` from CAO-1')
  expect(c?.service).toBe('admin-bff')
  expect(c?.provides[0]?.delta).toEqual(['+ a: string'])
  expect(c?.consumes[0]?.from).toBe('CAO-1')
  expect(c?.blockedBy.length).toBe(0)
})

test('parseTaskContext reads identity, plan and sub-tickets of an Obeya context', async () => {
  const ctx = parseTaskContext(context('CAO-219', { plan: PLAN, children: [['CAO-220', '[orders-api] Whitelist', 'done'], ['CAO-223', '[orders-api] OTP', 'in_dev']] }))
  expect(ctx.key).toBe('CAO-219')
  expect(ctx.status).toBe('planning')
  expect(ctx.branch).toBe('cao-219-x')
  expect(ctx.children).toEqual([{ key: 'CAO-220', title: '[orders-api] Whitelist', status: 'done' }, { key: 'CAO-223', title: '[orders-api] OTP', status: 'in_dev' }])
  expect(ctx.plan.includes('Block manifest')).toBe(false)
  expect(parseContract(ctx.plan)?.service).toBe('web-app')
})

test('parseLocalPlan takes id, status and blockers from the frontmatter when there is no header', async () => {
  const p = parseLocalPlan('/w/.loop/tasks/T-2-employee-render.md', '---\nid: T-2\nstatus: ready-for-agent\nservice: employee\nblocked_by: [T-1, none]\n---\n\n# Render the voucher\n\nbody')
  expect(p).toEqual({ id: 'T-2', title: 'Render the voucher', status: 'ready-for-agent', service: 'employee', blockedBy: [{ key: 'T-1', source: 'declared', evidence: 'blocked_by: [T-1, none]' }], contract: undefined })
  expect(parseLocalPlan('/w/CAO-301-plan.md', '# x').id).toBe('CAO-301')
})

test('parseRefs tells keys, links and paths apart', async () => {
  expect(parseRefs('CAO-219 https://obeya.example.com/tasks/CAO-223 .loop/tasks/ ./plan.md cao-7 --only')).toEqual({
    keys: ['CAO-219', 'CAO-223', 'CAO-7'],
    paths: ['.loop/tasks/', './plan.md'],
    only: true,
  })
})

test('buildPlan expands a parent into its sub-tickets, newest status wins, the header beats extracted contracts', async () => {
  const map = { ...emptyMap('/w'), sources: [{ ref: 'CAO-219', kind: 'obeya' as const, children: true, addedAt: '' }] }
  const parent = context('CAO-219', { children: [['CAO-222', '[orders-api] API', 'in_dev'], ['CAO-225', '[web-app] Tunnel', 'plan_review']] })
  const data = buildPlan({
    map,
    contexts: { 'CAO-219': { text: parent, at: 100 }, 'CAO-225': { text: context('CAO-225', { status: 'in_dev', plan: PLAN, branch: 'cao-225-tunnel' }), at: 200 } },
    files: {},
    extracted: [{ tickets: [{ key: 'CAO-222', service: 'orders-api', provides: [{ id: 'http orders-api GET /orders/summary', delta: ['+ payment_terms_days: integer|null'] }] }, { key: 'CAO-225', service: 'wrong' }] }],
    prs: { 'web-app': [{ headRefName: 'cao-225-tunnel', title: 'feat', number: 8967, state: 'OPEN', isDraft: false, url: 'https://github.com/acme/web-app/pull/8967' }] },
  })
  expect(data.epics.map(e => e.key)).toEqual(['CAO-219'])
  expect(data.tickets.map(t => t.key)).toEqual(['CAO-222', 'CAO-225'])
  const t222 = data.tickets[0]
  const t225 = data.tickets[1]
  expect(t222?.contractSource).toBe('extracted')
  expect(t222?.status).toBe('in_dev')
  expect(t225?.contractSource).toBe('header')
  expect(t225?.service).toBe('web-app')
  expect(t225?.status).toBe('in_dev') // its own read is newer than the parent's list
  expect(t225?.prs).toEqual([{ repo: 'web-app', number: 8967, state: 'open', url: 'https://github.com/acme/web-app/pull/8967' }])
  expect(data.missing).toEqual([])
})

test('buildPlan shows a ticket not read yet as loading, and honours --only and excluded', async () => {
  const map = { ...emptyMap('/w'), sources: [{ ref: 'CAO-300', kind: 'obeya' as const, children: true, addedAt: '' }, { ref: 'CAO-219', kind: 'obeya' as const, children: false, addedAt: '' }], excluded: ['CAO-301'] }
  const data = buildPlan({ map, contexts: { 'CAO-219': { text: context('CAO-219', { children: [['CAO-220', 't', 'done']] }), at: 1 } }, files: {}, extracted: [], prs: {} })
  expect(data.tickets.map(t => [t.key, t.status])).toEqual([['CAO-300', 'loading'], ['CAO-219', 'planning']])
  expect(data.missing).toEqual(['CAO-300'])
})

test('buildPlan reads local plan files', async () => {
  const map = { ...emptyMap('/w'), sources: [{ ref: '/w/T-2.md', kind: 'file' as const, addedAt: '' }] }
  const data = buildPlan({ map, contexts: {}, files: { '/w/T-2.md': `---\nid: T-2\nstatus: todo\n---\n# Voucher\n\n${PLAN}` }, extracted: [], prs: {} })
  expect(data.tickets[0]?.key).toBe('T-2')
  expect(data.tickets[0]?.service).toBe('web-app')
  expect(data.tickets[0]?.url).toBe('vscode://file/w/T-2.md')
  expect(data.tickets[0]?.blockedBy.length).toBe(2)
})

test('buildPlan lists the plan files next to one on the map, by id, so a ghost opens its file', async () => {
  const map = { ...emptyMap('/w'), sources: [{ ref: '/w/T-2.md', kind: 'file' as const, addedAt: '' }] }
  const data = buildPlan({
    map,
    contexts: {},
    files: { '/w/T-2.md': '---\nid: T-2\nblocked_by: [CAO-301]\n---\n# Voucher' },
    extracted: [],
    prs: {},
    nearby: { '/w/CAO-301-plan.md': '# Refunds', '/w/T-2 copy.md': '---\nid: T-2\n---\n# Old' },
  })
  expect(data.nearby).toEqual({ 'CAO-301': { path: '/w/CAO-301-plan.md', url: 'vscode://file/w/CAO-301-plan.md' } })
})

test('prsFor matches the branch, the key prefix or the title, never another key that starts the same', async () => {
  const rows = [
    { headRefName: 'cao-22-x', title: 'a', number: 1, state: 'OPEN', isDraft: false, url: 'u1' },
    { headRefName: 'cao-220-x', title: 'b', number: 2, state: 'MERGED', isDraft: false, url: 'u2' },
    { headRefName: 'other', title: 'fix (CAO-220)', number: 3, state: 'OPEN', isDraft: true, url: 'u3' },
  ]
  expect(prsFor(rows, 'r', 'CAO-220').map(p => [p.number, p.state])).toEqual([[2, 'merged'], [3, 'draft']])
})

test('helpers: textOf, parseLine, portFor', async () => {
  expect(textOf([{ type: 'text', text: 'a' }, { content: [{ text: 'b' }] }])).toBe('a\nb')
  expect(parseLine('{"add":"CAO-1"}')).toEqual({ add: 'CAO-1' })
  expect(parseLine('{"remove":""}')).toEqual({ remove: '' })
  expect(parseLine('nope')).toBe(undefined)
  expect(portFor('abc')).toBe(portFor('abc'))
  expect(portFor('abc') >= 20000 && portFor('abc') < 60000).toBe(true)
})

test('/plan-control add puts a plan file on this session’s map, under ~/.plan-control/maps', async ($, on) => {
  const written: Record<string, string> = {}
  on('command.register', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('env.get', (_, e) => ({ value: (e as { name?: string }).name === 'HOME' ? '/home/z' : undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', (_, e) => ((e as { path?: string }).path === '/w/plans/T-2.md' ? { value: { kind: 'file', size: 10, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_, e) => {
    const w = e as { path: string; text: string }
    written[w.path] = w.text
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'plan-control', args: 'add plans/T-2.md missing.md' })
  expect(String((r as { text?: string }).text)).toContain('added T-2.md')
  expect(String((r as { text?: string }).text)).toContain('missing.md: not found')
  const map = JSON.parse(written['/home/z/.plan-control/maps/sess-1.json'] ?? '{}')
  expect(map.sources.map((x: { ref: string; kind: string }) => [x.ref, x.kind])).toEqual([['/w/plans/T-2.md', 'file']])
})

test('summarize counts done, ready, reading and declared mismatches', async () => {
  const map = { ...emptyMap('/w'), sources: [{ ref: 'CAO-219', kind: 'obeya' as const, children: true, addedAt: '' }] }
  const parent = context('CAO-219', { children: [['CAO-222', '[orders-api] API', 'done'], ['CAO-225', '[web-app] Tunnel', 'plan_review'], ['CAO-230', '[web-app] Later', 'planning']] })
  const data = buildPlan({
    map,
    contexts: { 'CAO-219': { text: parent, at: 100 }, 'CAO-225': { text: context('CAO-225', { plan: PLAN }), at: 50 } },
    files: {},
    extracted: [{ tickets: [{ key: 'CAO-222', provides: [{ id: 'http orders-api GET /orders/summary', delta: ['+ payment_terms_days: integer|null'] }] }, { key: 'CAO-230', blockedBy: [{ key: 'CAO-225', source: 'declared', evidence: 'x' }] }] }],
    prs: {},
  })
  // CAO-225 waits on CAO-223, which is not on the map: not ready. It reads requires_engagement, which CAO-222 does not add.
  expect(summarize(data)).toEqual({ title: data.title, tickets: 3, done: 1, ready: 0, reading: 0, mismatches: 1 })
})

test('the band shows the map and the page link, and nothing without a map', async ($, on) => {
  on('state.get', () => ({ value: { value: { title: 'CAO-219 · Deferred payment', tickets: 11, done: 2, ready: 2, reading: 0, mismatches: 2, link: 'http://localhost:4242/tok/' }, version: 1 } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'plan-control', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160 } })
    expect((await ui.find({ type: 'Text', text: /11 tickets · 2 done · 2 ready/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /2 mismatches/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Link' })) !== undefined).toBe(true)
    await ui.unmount()
  }
})

test('parseContract reads Service and Blocked by when Obeya joined them into one paragraph', async () => {
  const c = parseContract('## Contract\n\n**Service:** web-app **Blocked by:** CAO-222, CAO-223\n\n### Provides\n\nnone')
  expect(c?.service).toBe('web-app')
  expect(c?.blockedBy.map(d => d.key)).toEqual(['CAO-222', 'CAO-223'])
})

test('fieldOf drops section words; checkConsume matches path suffixes, skips bare entries, suggests an id', async () => {
  expect(fieldOf('+ header X-Payment-Otp-Token')).toBe('X-Payment-Otp-Token')
  expect(fieldOf('+ X-Payment-Otp-Token: string (obligatoire, en-tête)')).toBe('X-Payment-Otp-Token')
  expect(fieldOf('+ response 200 payment_terms_days: integer')).toBe('payment_terms_days')
  const provider = (provides: Ticket['provides']): Ticket => ({ key: 'P', kind: 'obeya', title: '', status: 'done', service: 's', contractSource: 'header', blockedBy: [], provides, consumes: [], files: [], prs: [] })
  const id = 'http admin-bff POST /orders/confirm-deferred-payment'
  const p = provider([{ id, delta: ['+ orderId: uuid', '+ X-Payment-Otp-Token: string', '+ order.paymentTermsDays: number', '- legacyFlag'] }])
  expect(checkConsume({ id, from: 'P', existing: false, delta: ['+ header X-Payment-Otp-Token', '+ paymentTermsDays: number', '+ orderId: uuid'] }, p)).toEqual({ missing: [], removed: [], noProvider: false, unchecked: false })
  expect(checkConsume({ id, from: 'P', existing: false, delta: ['+ legacyFlag: boolean', '+ other: x'] }, p)).toEqual({ missing: ['legacyFlag', 'other'], removed: ['legacyFlag'], noProvider: false, unchecked: false })
  expect(checkConsume({ id, from: 'P', existing: false, delta: ['+ a: x'] }, provider([{ id, delta: [] }]))).toEqual({ missing: [], removed: [], noProvider: false, unchecked: true })
  const show = 'http orders-api GET /shop/api/v0/orders/:id/show'
  expect(checkConsume({ id: 'http orders-api GET /shop/api/v0/orders/:id', from: 'P', existing: false, delta: [] }, provider([{ id: show, delta: ['+ x: y'] }])).suggestion).toBe(show)
})

test('an (existing, unchanged) consumed interface is never checked against a provider', async () => {
  const id = 'http orders-api POST /save_contact'
  const contract = (body: string) => `## Contract\n\n**Service:** web-app\n\n${body}`
  const map = { ...emptyMap('/w'), sources: [{ ref: '/w/A.md', kind: 'file' as const, addedAt: '' }, { ref: '/w/B.md', kind: 'file' as const, addedAt: '' }] }
  const data = buildPlan({
    map,
    contexts: {},
    files: {
      '/w/A.md': `---\nid: A\nstatus: done\n---\n${contract(`### Provides\n- \`${id}\`\n  \`\`\`diff\n  + payment_terms_days: integer\n  \`\`\``)}`,
      '/w/B.md': `---\nid: B\n---\n${contract(`### Consumes\n- \`${id}\` (existing, unchanged)\n  \`\`\`diff\n  + deferred_payment_eligible: boolean\n  \`\`\``)}`,
    },
    extracted: [],
    prs: {},
  })
  expect(data.tickets[1]?.consumes[0]?.checks).toEqual({})
  expect(summarize(data).mismatches).toBe(0)
})

test('applyMove keeps where a box was dropped, puts one or all back, refuses junk', async () => {
  const one = applyMove({}, 'CAO-223 120.4 -30')
  expect(one).toEqual({ 'CAO-223': { x: 120, y: -30 } })
  expect(applyMove({ ...one, 'T-2': { x: 1, y: 2 } }, 'CAO-223 reset')).toEqual({ 'T-2': { x: 1, y: 2 } })
  expect(applyMove({ 'T-2': { x: 1, y: 2 } }, '* reset')).toEqual({})
  expect(applyMove({}, 'CAO-1 x 3')).toBe(undefined)
  expect(applyMove({}, '../evil 1 2')).toBe(undefined)
  expect(parseLine('{"move":"CAO-1 3 4"}')).toEqual({ move: 'CAO-1 3 4' })
  expect(parseLine('{"refresh":"all"}')).toEqual({ refresh: 'all' })
  expect(parseLine('{"refresh":"/plans/a.md"}')).toEqual({ refresh: '/plans/a.md' })
})
