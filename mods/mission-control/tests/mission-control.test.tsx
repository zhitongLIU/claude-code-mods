import { describe, expect, mock, test } from 'claude-code/testing'

import { edges, importsOf, layout, mapData, titleOf } from '../hooks/map'
import { label, lines, summary } from '../hooks/tree'
import { cap } from '../hooks/register'

let mockClock: any
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } }

// Stands for the engine beneath the mod.
function engine(on: any, opts: { cmux?: boolean } = {}) {
  const runs: string[][] = []
  const models: number[] = []
  const writes: Record<string, string> = {}
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  const clock = mock.clock(on)
  mockClock = clock
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'ag1' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('fs.read', (_$: any, e: any) => ({ value: e.path.endsWith('login.tsx') ? "import { start } from '../auth/session'\n" : '' }))
  on('fs.write', (_$: any, e: any) => ((writes[e.path] = e.text), { value: undefined }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'CMUX_WORKSPACE_ID' ? (opts.cmux ? 'ws' : undefined) : '/tmp/' }))
  on('process.run', (_$: any, e: any) => (runs.push(e.argv), { value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('model.complete', () => (models.push(1), { value: { isAnswered: true, text: '["tokens now expire after an hour"]', usage: { input_tokens: 1, output_tokens: 1 } } }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'band below' }))
  return { runs, writes, clock, models, opts }
}

describe('mission-control', () => {
  test('bug fixes from the demo video', () => {
    // 1. A chain of imports lands in one column per depth, with an edge per import, a→c skipping b's column.
    const f = (path: string, imports: string[]) => ({ path, act: 'edit' as const, at: 0, changedTurn: 1, imports })
    const chain = [f('/r/a.ts', ['/r/b', '/r/c']), f('/r/b.ts', ['/r/c']), f('/r/c.ts', [])]
    const out = mapData(chain, { at: 99_999, turn: 1 })
    expect(out.columns.map(col => col.map(c => c.title))).toEqual([['a.ts'], ['b.ts'], ['c.ts']])
    expect(out.edges).toEqual([
      { from: '/r/a.ts', to: '/r/b.ts', hot: true },
      { from: '/r/a.ts', to: '/r/c.ts', hot: true },
      { from: '/r/b.ts', to: '/r/c.ts', hot: true },
    ])
  })


  test('review fixes: the cap keeps main and the agents', async ($, on) => {
    const many = [
      { id: 'main', parent: null, kind: 'main' as const, label: 'main', family: 'main', status: 'running' as const, start: 0 },
      { id: 'ag', parent: 'main', kind: 'agent' as const, label: 'a', family: 'agent', status: 'running' as const, start: 0 },
      ...Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, parent: 'main', kind: 'tool' as const, label: 'x', family: 'bash', status: 'done' as const, start: i })),
    ]
    const kept = cap(many)
    expect(kept).toHaveLength(300)
    expect(kept[0]?.id).toBe('main')
    expect(kept.some(n => n.id === 'ag')).toBe(true)
    expect(kept.at(-1)?.id).toBe('t399') // the newest calls stay
    const crowd = Array.from({ length: 310 }, (_, i) => ({ id: `a${i}`, parent: 'main', kind: 'agent' as const, label: 'a', family: 'agent', status: 'done' as const, start: i }))
    expect(cap([...crowd, ...many.slice(2)]).filter(n => n.kind === 'tool')).toHaveLength(0) // no room left: no tool calls
  })

  test('a background agent still running keeps its open calls when main ends', async ($, on) => {
    const { writes, clock } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    await $.agent.spawn({ prompt: 'p', description: 'long runner' } as any) // agent ag1, background
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any) // main ends, ag1 runs on
    await $.command.run({ command: 'mission', args: '' } as any)
    await clock.advance(1600)
    expect(writes['/tmp/mission-control/data.js']).toContain('"agents":1,"running":1') // still running
  })

  test('labels tool calls by family', () => {
    expect(label({ tool: 'Bash', description: 'Run tests' })).toEqual({ label: 'Run tests', family: 'bash' })
    expect(label({ tool: 'mcp__playwright__browser_click' })).toEqual({ label: 'click', family: 'browser' })
    expect(label({ tool: 'mcp__claude_ai_Slack__slack_send_message' })).toEqual({ label: 'slack_send_message', family: 'mcp:Slack' })
  })

  test('the who tree nests agents and folds runs of one tool family', () => {
    const at = 10_000
    const ls = lines(
      [
        { id: 'main', parent: null, kind: 'main', label: 'main · fix login', family: 'main', status: 'running', start: 0 },
        { id: 'a', parent: 'main', kind: 'agent', label: 'test login flow', family: 'agent', status: 'running', start: 1000 },
        { id: 't1', parent: 'a', kind: 'tool', label: 'navigate', family: 'browser', status: 'done', start: 1000, end: 2000 },
        { id: 't2', parent: 'a', kind: 'tool', label: 'click', family: 'browser', status: 'running', start: 2000 },
        { id: 't3', parent: 'main', kind: 'tool', label: 'npm test', family: 'bash', status: 'failed', start: 3000, end: 4000 },
      ],
      at,
    )
    expect(ls.map(l => l.prefix + l.text)).toEqual([
      '◆ main · fix login  10s',
      '├─ ● test login flow  9.0s · 2 tools',
      '│  └─ ◎ browser: navigate → click  ×2  9.0s',
      '└─ $ bash: npm test  1.0s',
    ])
    expect(ls[2]?.status).toBe('running')
    expect(ls[3]?.status).toBe('failed')
  })

  test('the code map finds imports, columns and hands the page its data', () => {
    expect(importsOf('/r/src/pages/login.tsx', "import { a } from '../auth/session'\nconst b = require('./x.js')")).toEqual(['/r/src/auth/session', '/r/src/pages/x'])
    expect(importsOf('/r/app/views.py', 'from .models import User\nfrom ..core.db import q')).toEqual(['/r/app/models', '/r/core/db'])
    const files = [
      { path: '/r/a.ts', act: 'read' as const, at: 0, changedTurn: 0, imports: ['/r/b'] },
      { path: '/r/b.ts', act: 'edit' as const, at: 0, changedTurn: 2, imports: [], why: 'adds a & b <check>' },
    ]
    expect(edges(files)).toEqual([{ from: '/r/a.ts', to: '/r/b.ts' }])
    expect(layout(files, edges(files))).toEqual([['/r/a.ts'], ['/r/b.ts']])
    const out = mapData(files, { at: 99_999, turn: 2 })
    expect(out.changed).toBe(1)
    expect(out.columns.flat().find(c => c.title === 'b.ts')).toMatchObject({ state: 'changed', why: 'adds a & b <check>' }) // text stays text: the page sets it with textContent
    const regs = ['/m/merge-gate/hooks/register.tsx', '/m/snake/hooks/register.tsx']
    expect(titleOf(regs[0] as string, regs)).toBe('merge-gate › register.tsx')
    expect(titleOf('/m/a/login.tsx', regs)).toBe('login.tsx')
  })

  test('the "why" is only asked for once the code map is on screen', async ($, on) => {
    const { writes, clock, models } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' } as any)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/auth/session.ts', old_string: 'a', new_string: 'b' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await clock.advance(1600)
    expect(models).toHaveLength(0) // nobody is looking: no model call
    await $.command.run({ command: 'mission', args: 'code' } as any)
    await clock.advance(1600)
    expect(models).toHaveLength(1) // looking now: one batched call for what changed
    expect(writes['/tmp/mission-control/data.js'] ?? '').toContain('tokens now expire')
    await $.command.run({ command: 'mission', args: 'code' } as any)
    await clock.advance(1600)
    expect(models).toHaveLength(1) // already explained: not asked twice
  })

  test('a turn fills the tree and the band; /mission opens the page and keeps its data fresh', async ($, on) => {
    const { runs, writes, clock, opts } = engine(on, { cmux: true })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' } as any)
    await $.agent.spawn({ prompt: 'check it', description: 'test login flow' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/pages/login.tsx' } as any)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/auth/session.ts', old_string: 'a', new_string: 'b' } as any)
    await clock.advance(1600)
    expect(writes['/tmp/mission-control/data.js']).toBeUndefined() // /mission has not opened the page: nothing is written

    const band = await $.ui.mount({ plugin: 'mission', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /1\/1 agents · 2 tools · 1 files changed/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /band below/ })).toBeDefined()
    await band.unmount()

    const r = await $.command.run({ command: 'mission', args: 'code' } as any)
    expect(r.text).toMatch(/1 agents · 2 tool calls · 2 files/)
    expect(runs.some(a => a[0] === 'cmux' && a.includes('open-split') && a.some(x => x.endsWith('/mission-control/index.html#code')))).toBe(true)
    expect(writes['/tmp/mission-control/index.html']).toContain('Mission Control')
    const first = JSON.parse((writes['/tmp/mission-control/data.js'] ?? '').replace(/^window\.MAP = /, '').replace(/;$/, ''))
    expect(first.who.lines.map((l: any) => l.text)).toEqual(expect.arrayContaining([expect.stringMatching(/◆ main · fix the login bug/), expect.stringMatching(/● test login flow/), expect.stringMatching(/✎ edit: auth\/session\.ts/)]))

    // 2. Images are not code: a screenshot read now stays off the map.
    await $.tool.call({ tool: 'Read', file_path: '/repo/shots/v2.png' } as any)
    // 5. Claude Code's own bookkeeping is not a tool call in the tree.
    await $.tool.call({ tool: 'SubagentHandback', summary: 'done' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await clock.advance(1600) // the data follows the work without anyone asking
    const data = writes['/tmp/mission-control/data.js'] ?? ''
    expect(data).toContain('login.tsx')
    expect(data).toContain('session.ts')
    expect(data).not.toContain('"id":"/repo/shots/v2.png"') // an image is not on the code map
    expect(data).not.toContain('SubagentHandback')
    expect(data).toContain('"from":"/repo/src/pages/login.tsx"') // the import edge login → session
    expect(data).toContain('tokens now expire after an hour') // the why, never cut

    // Outside cmux the default browser opens it; /mission off stops the writing.
    opts.cmux = false
    runs.length = 0
    await $.command.run({ command: 'mission', args: '' } as any)
    expect(runs.some(a => a[0] === 'open' && String(a[1]).endsWith('/index.html#who'))).toBe(true)
    await $.command.run({ command: 'mission', args: 'off' } as any)
    const before = writes['/tmp/mission-control/data.js']
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/zzz.ts' } as any)
    await clock.advance(1600)
    expect(writes['/tmp/mission-control/data.js']).toBe(before)
    expect(summary([]).tools).toBe(0)
  })
})
