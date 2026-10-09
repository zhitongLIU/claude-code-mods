import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseContract, parseTaskContext } from './contract.ts'

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
  '- `http orders-api GET /shop/public/api/v0/orders/summary` from CAO-222',
  '  ```diff',
  '  + payment_terms_days: integer(30|45|60)|null',
  '  + requires_engagement: boolean',
  '  ```',
  '- `http admin-bff POST /orders/request-payment-otp` (existing, unchanged)',
  '',
  '## Contexte',
  '- `not an interface` from CAO-999',
].join('\n')

test('parseContract reads service, blockers, and the consumed delta', () => {
  const c = parseContract(PLAN)
  assert.ok(c)
  assert.equal(c.service, 'web-app')
  assert.deepEqual(c.blockedBy.map(d => d.key), ['CAO-222', 'CAO-223'])
  assert.equal(c.provides.length, 0)
  assert.equal(c.consumes.length, 2)
  assert.deepEqual(c.consumes[0], {
    id: 'http orders-api GET /shop/public/api/v0/orders/summary',
    from: 'CAO-222',
    existing: false,
    delta: ['+ payment_terms_days: integer(30|45|60)|null', '+ requires_engagement: boolean'],
  })
  assert.equal(c.consumes[1].existing, true)
})

test('parseContract stops at the next section and is undefined without a header', () => {
  assert.ok(!parseContract(PLAN)?.consumes.some(x => x.id === 'not an interface'))
  assert.equal(parseContract('## Contexte\n\nno header here'), undefined)
})

test('parseContract merges per-service blocks of a multi-service plan', () => {
  const c = parseContract('## Contract — admin-bff\n**Blocked by:** none\n### Provides\n- `http admin-bff GET /x`\n  ```diff\n  + a: string\n  ```\n## Contract — web-app\n### Consumes\n- `http admin-bff GET /x` from CAO-1')
  assert.equal(c?.service, 'admin-bff')
  assert.equal(c?.provides[0].delta[0], '+ a: string')
  assert.equal(c?.consumes[0].from, 'CAO-1')
  assert.equal(c?.blockedBy.length, 0)
})

test('parseTaskContext reads identity, plan and children of an Obeya context', () => {
  const raw = [
    '## 1. IDENTITY', '', '<untrusted id="1" source="mcp">', '- Clé : CAO-219', '- Titre : Deferred payment', '- Statut : planning', '- Branche : cao-219-payment', '</untrusted-1>', '',
    '## 3. PLAN', '', '<untrusted id="1" source="mcp">', PLAN, '</untrusted-1>', '', '**Block manifest (revisionId: x):** …', '',
    '## 4. DECOMPOSITION', '',
    '- **CAO-220** <untrusted id="1" source="mcp">', '[orders-api] Whitelist', '</untrusted-1> — done',
    '- **CAO-223** <untrusted id="1" source="mcp">', '[orders-api] OTP', '</untrusted-1> — in_dev',
    '', '## 5. RECENT', '',
  ].join('\n')
  const ctx = parseTaskContext(raw)
  assert.equal(ctx.key, 'CAO-219')
  assert.equal(ctx.status, 'planning')
  assert.equal(ctx.branch, 'cao-219-payment')
  assert.deepEqual(ctx.children, [
    { key: 'CAO-220', title: '[orders-api] Whitelist', status: 'done' },
    { key: 'CAO-223', title: '[orders-api] OTP', status: 'in_dev' },
  ])
  assert.equal(parseContract(ctx.plan)?.service, 'web-app')
  assert.ok(!ctx.plan.includes('Block manifest'))
})
