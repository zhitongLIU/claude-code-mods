import { describe, expect, mock, test } from 'claude-code/testing'

import { categoryOf } from '../hooks/category'
import { addedDiff, formatComment, formatReview, parseDiff } from '../hooks/diff'
import { highlight } from '../hooks/highlight'
import { htmlRows, langOf } from '../hooks/hl'
import { linksOf } from '../hooks/lang'
import { edges, importsOf, layout, mapData, titleOf } from '../hooks/map'
import { label, lines, summary } from '../hooks/tree'
import { cap, parsePr } from '../hooks/register'
import { TEMPLATE } from '../hooks/template'

let mockClock: any
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } }

// Stands for the engine beneath the mod.
function engine(on: any, opts: { cmux?: boolean; focus?: string; git?: (argv: string[]) => string | undefined } = {}) {
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
  on('process.run', (_$: any, e: any) => {
    runs.push(e.argv)
    const out = e.argv[0] === 'git' || e.argv[0] === 'gh' ? opts.git?.(e.argv) : e.argv[1] === 'identify' ? opts.focus : ''
    return { value: { exitCode: out === undefined ? 1 : 0, stdout: out ?? '', stderr: '' } }
  })
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
    expect(out.groups[0]?.columns.map(col => col.map(c => c.title))).toEqual([['a.ts'], ['b.ts'], ['c.ts']])
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
    expect(writes['/tmp/mission-control/s/data.js']).toContain('"agents":1,"running":1') // still running
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
    expect(out.groups.flatMap(g => g.columns.flat()).find(c => c.title === 'b.ts')).toMatchObject({ state: 'changed', why: 'adds a & b <check>' }) // text stays text: the page sets it with textContent
    const regs = ['/m/merge-gate/hooks/register.tsx', '/m/snake/hooks/register.tsx']
    expect(titleOf(regs[0] as string, regs)).toBe('merge-gate › register.tsx')
    expect(titleOf('/m/a/login.tsx', regs)).toBe('login.tsx')
  })

  test('ruby files link by the constants they mention and by require_relative', () => {
    const rb = '/r/app/domains/orders/commands/request_chorus_otp.rb'
    const links = linksOf('/r/app/controllers/orders_controller.rb', [
      '# RequestChorusOtp in a comment does not count',
      'class OrdersController',
      '  def create = Orders::Commands::RequestChorusOtp.call(params)',
      "  require_relative '../lib/helpers'",
      'end',
    ].join('\n'))
    expect(links.names).toEqual(expect.arrayContaining(['OrdersController', 'Orders', 'Commands', 'RequestChorusOtp']))
    expect(links.imports).toEqual(['/r/app/lib/helpers'])
    const f = (path: string, names: string[] = [], imports: string[] = []) => ({ path, act: 'edit' as const, at: 0, changedTurn: 1, imports, names })
    const files = [
      f('/r/app/controllers/orders_controller.rb', links.names, links.imports),
      f(rb, ['ChorusOtpRateLimit']),
      f('/r/app/domains/concerns/chorus_otp_rate_limit.rb'),
      f('/r/app/models/base.rb', ['Base']), // too common a name to link by
      f('/r/app/models/user.rb', ['Base']),
    ]
    expect(edges(files)).toEqual([
      { from: '/r/app/controllers/orders_controller.rb', to: rb },
      { from: rb, to: '/r/app/domains/concerns/chorus_otp_rate_limit.rb' },
    ])
    // The adapter is picked by extension: a .ts file mentioning a Ruby-looking name links to nothing.
    expect(edges([f('/r/a.ts', ['RequestChorusOtp']), f(rb)])).toEqual([])
  })

  test('the "why" is only asked for once the code map is on screen', async ($, on) => {
    const { writes, clock, models } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' } as any)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/auth/session.ts', old_string: 'a', new_string: 'b' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await clock.advance(1600)
    expect(models).toHaveLength(0) // nobody is looking: no model call
    await $.command.run({ command: 'mission', args: '' } as any)
    await clock.advance(1600)
    expect(models).toHaveLength(1) // looking now: one batched call for what changed
    expect(writes['/tmp/mission-control/s/data.js'] ?? '').toContain('tokens now expire')
    await $.command.run({ command: 'mission', args: '' } as any)
    await clock.advance(1600)
    expect(models).toHaveLength(1) // already explained: not asked twice
  })

  test('a file Claude changes gets its diff against HEAD for the drawer, written apart from data.js', async ($, on) => {
    const patch = '@@ -1 +1 @@\n-a\n+b\n'
    const git = (argv: string[]) => {
      const cmd = argv.slice(argv[1] === '-C' ? 3 : 1).join(' ')
      if (cmd === 'diff HEAD --no-color -U3 -- /repo/src/auth/session.ts') return patch
      if (cmd.startsWith('diff HEAD')) return '' // nothing against HEAD for the rest
      if (cmd.startsWith('ls-files --error-unmatch')) return undefined // git does not know it: new file
      if (cmd === 'rev-parse --abbrev-ref HEAD') return 'main\n'
      return undefined // no gh here: the branch has no pull request
    }
    const { writes, clock } = engine(on, { git })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.command.run({ command: 'mission', args: '' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/auth/session.ts', old_string: 'a', new_string: 'b' } as any)
    await $.tool.call({ tool: 'Write', file_path: '/repo/src/pages/login.tsx', content: 'x' } as any) // new: the mock reads it as one import line
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/other.ts' } as any) // only read: no diff
    await clock.advance(1600)
    const shown = JSON.parse((writes['/tmp/mission-control/s/diffs.js'] ?? '').replace(/^window\.DIFFS = /, '').replace(/;$/, ''))
    expect(Object.keys(shown).sort()).toEqual(['/repo/src/auth/session.ts', '/repo/src/pages/login.tsx'])
    expect(writes['/tmp/mission-control/s/data.js']).toContain('"where":{"branch":"main"}') // plain /mission: the branch we are on
    expect(shown['/repo/src/auth/session.ts'].text).toBe(patch)
    expect(shown['/repo/src/pages/login.tsx'].text).toMatch(/^@@ -0,0 \+1,1 @@\n\+import /) // an untracked file reads as all added
    const rev = (writes['/tmp/mission-control/s/data.js'] ?? '').match(/"rev":(-?\d+)/)?.[1]
    expect(rev).toBeDefined()
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/zzz.ts' } as any)
    await clock.advance(1600)
    expect((writes['/tmp/mission-control/s/data.js'] ?? '').match(/"rev":(-?\d+)/)?.[1]).toBe(rev) // same diffs: the page is not told to reload them
  })

  test('a turn fills the tree and the band; /mission opens the page and keeps its data fresh', async ($, on) => {
    const { runs, writes, clock, opts } = engine(on, { cmux: true, focus: JSON.stringify({ focused: { workspace_ref: 'workspace:13' } }) })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' } as any)
    await $.agent.spawn({ prompt: 'check it', description: 'test login flow' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/pages/login.tsx' } as any)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/auth/session.ts', old_string: 'a', new_string: 'b' } as any)
    await clock.advance(1600)
    expect(writes['/tmp/mission-control/s/data.js']).toBeUndefined() // /mission has not opened the page: nothing is written

    const band = await $.ui.mount({ plugin: 'mission', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /1\/1 agents · 2 tools · 1 files changed/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /band below/ })).toBeDefined()
    await band.unmount()

    const r = await $.command.run({ command: 'mission', args: '' } as any)
    expect(r.text).toMatch(/1 agents · 2 tool calls · 2 files/)
    expect(runs.some(a => a[0] === 'cmux' && a.includes('open-split') && a.some(x => x.endsWith('/mission-control/s/index.html')))).toBe(true)
    expect(runs.some(a => a[0] === 'cmux' && a.join(' ').includes('--workspace workspace:13'))).toBe(true) // the workspace in focus, not the one in the stale env
    expect(writes['/tmp/mission-control/s/index.html']).toContain('Mission Control')
    const first = JSON.parse((writes['/tmp/mission-control/s/data.js'] ?? '').replace(/^window\.MAP = /, '').replace(/;$/, ''))
    expect(first.who.lines.map((l: any) => l.text)).toEqual(expect.arrayContaining([expect.stringMatching(/◆ main · fix the login bug/), expect.stringMatching(/● test login flow/), expect.stringMatching(/✎ edit: auth\/session\.ts/)]))

    // 2. Images are not code: a screenshot read now stays off the map.
    await $.tool.call({ tool: 'Read', file_path: '/repo/shots/v2.png' } as any)
    // 5. Claude Code's own bookkeeping is not a tool call in the tree.
    await $.tool.call({ tool: 'SubagentHandback', summary: 'done' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as any)
    await clock.advance(1600) // the data follows the work without anyone asking
    const data = writes['/tmp/mission-control/s/data.js'] ?? ''
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
    expect(runs.some(a => a[0] === 'open' && String(a[1]).endsWith('/index.html'))).toBe(true)
    expect(runs.some(a => a[0] === 'cmux')).toBe(false) // outside cmux nothing of cmux is touched
    await $.command.run({ command: 'mission', args: 'off' } as any)
    const before = writes['/tmp/mission-control/s/data.js']
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/zzz.ts' } as any)
    await clock.advance(1600)
    expect(writes['/tmp/mission-control/s/data.js']).toBe(before)
    expect(summary([]).tools).toBe(0)
  })
  test('/mission main fills the code map from git once, then the live map carries on', async ($, on) => {
    const git = (argv: string[]) => {
      const cmd = argv.slice(argv[1] === '-C' ? 3 : 1).join(' ')
      if (cmd === 'rev-parse --show-toplevel') return '/repo\n'
      if (cmd.startsWith('diff --name-only -z main')) return 'src/pages/login.tsx\0src/auth/session.ts\0shots/v2.png\0'
      if (cmd.startsWith('diff --name-only -z HEAD')) return 'src/pages/login.tsx\0'
      if (cmd.startsWith('ls-files')) return 'src/new.ts\0'
      if (cmd.startsWith('diff -U3')) return '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n'
      if (cmd === 'rev-parse --abbrev-ref HEAD') return 'feat/otp\n'
      if (cmd === 'pr view --json number,url') return '{"number":12,"url":"https://github.com/swile/app/pull/12"}'
      return undefined // an unknown base: git fails
    }
    const { runs, writes, clock, models } = engine(on, { git })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    const r = await $.command.run({ command: 'mission', args: 'main' } as any)
    expect(r.text).toMatch(/review: 3 changed files against main/) // the png is not code
    expect(runs.some(a => a[0] === 'open' && String(a[1]).endsWith('/index.html#code'))).toBe(true)
    await clock.advance(1600)
    const data = writes['/tmp/mission-control/s/data.js'] ?? ''
    expect(data).toContain('"id":"/repo/src/pages/login.tsx"')
    expect(data).toContain('"id":"/repo/src/new.ts"')
    expect(data).toContain('"state":"changed"') // shown as changed, with no turn running
    expect(data).toContain('"from":"/repo/src/pages/login.tsx"') // imports linked as on the live map
    expect(data).toContain('tokens now expire after an hour') // the one-line summary of each diff
    expect(models).toHaveLength(1)
    const shown = JSON.parse((writes['/tmp/mission-control/s/diffs.js'] ?? '').replace(/^window\.DIFFS = /, '').replace(/;$/, ''))
    expect(shown['/repo/src/pages/login.tsx'].text).toContain('@@ -1 +1 @@') // the drawer's diff, whole
    expect(shown['/repo/src/pages/login.tsx'].ref).toBe('main')
    expect(shown['/repo/src/new.ts'].text).toBe('') // untracked, and the file reads empty: nothing to show
    expect(JSON.parse(data.replace(/^window\.MAP = /, '').replace(/;$/, '')).diffs.paths).toContain('/repo/src/pages/login.tsx') // data.js only names who has one
    expect(JSON.parse(data.replace(/^window\.MAP = /, '').replace(/;$/, '')).where).toEqual({ branch: 'feat/otp', base: 'main', pr: { number: 12, url: 'https://github.com/swile/app/pull/12' } }) // the branch we are on, against main, and its pull request

    // HEAD is the uncommitted changes; a name git does not know is an error.
    expect((await $.command.run({ command: 'mission', args: 'HEAD' } as any)).text).toMatch(/against HEAD/)
    expect((await $.command.run({ command: 'mission', args: 'nope' } as any)).text).toMatch(/could not diff against "nope"/)

    // A real turn takes over: the review glow goes, the files stay.
    await $.turn.start({ text: 'carry on', turnId: 't1' } as any)
    await clock.advance(1600)
    const after = writes['/tmp/mission-control/s/data.js'] ?? ''
    expect(after).not.toContain('"state":"changed"')
    expect(after).toContain('"id":"/repo/src/pages/login.tsx"')
  })
  test('/mission <PR link> reads a pull request link through gh alone, from any folder', async ($, on) => {
    const sha = 'a'.repeat(40)
    const gh = (argv: string[]) => {
      const cmd = argv.slice(1).join(' ')
      if (argv[0] === 'git') return undefined // not inside any repository
      if (cmd.startsWith('api repos/swile/app/pulls/7 ')) return JSON.stringify({ sha, base: 'main', head: 'feat/otp', url: 'https://github.com/swile/app/pull/7' })
      if (cmd.startsWith('api repos/swile/app/pulls/7/files?per_page=100')) {
        return [
          { filename: 'src/pages/login.tsx', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' },
          { filename: 'src/gone.ts', status: 'removed' },
          { filename: 'docs/logo.png', status: 'added' },
        ].map(f => JSON.stringify(f)).join('\n')
      }
      if (cmd === `api -H Accept: application/vnd.github.raw repos/swile/app/contents/src/pages/login.tsx?ref=${sha}`) return "import { start } from '../auth/session'\n"
      return undefined // any other pull request: gh fails
    }
    const { runs, writes, clock } = engine(on, { git: gh })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/nowhere' } as any)
    const r = await $.command.run({ command: 'mission', args: 'https://github.com/swile/app/pull/7/files' } as any)
    expect(r.text).toMatch(/review: 1 changed files against PR #7 \(main\)/) // the removed file and the png are left out
    expect(runs.some(a => a[0] === 'git')).toBe(false) // no clone, no fetch
    await clock.advance(1600)
    const data = writes['/tmp/mission-control/s/data.js'] ?? ''
    expect(data).toContain('"id":"/swile/app/src/pages/login.tsx"')
    expect(data).toContain('tokens now expire after an hour') // summarised from the patch
    expect(JSON.parse(data.replace(/^window\.MAP = /, '').replace(/;$/, '')).where).toEqual({ branch: 'feat/otp', base: 'main', pr: { number: 7, url: 'https://github.com/swile/app/pull/7' } })
    expect(writes['/tmp/mission-control/s/diffs.js']).toContain('@@ -1 +1 @@\\n-old\\n+new') // the patch itself reaches the drawer
    expect(writes['/tmp/mission-control/s/diffs.js']).toContain('PR #7 (main) swile/app@aaaaaaa') // and says which pull request it is
    expect((await $.command.run({ command: 'mission', args: 'https://github.com/swile/app/pull/8' } as any)).text).toMatch(/could not read swile\/app pull request #8/)
    expect(parsePr('https://github.com/swile/app/pull/7/files')).toEqual({ repo: 'swile/app', number: '7' })
    expect(parsePr('#7')).toEqual({ repo: undefined, number: '7' })
    expect(parsePr('main')).toBeUndefined()
  })

  test('/mission #123 reads a pull request of this repository from git, not the disk', async ($, on) => {
    let fetched = ''
    const git = (argv: string[]) => {
      const cmd = argv.slice(argv[1] === '-C' ? 3 : 1).join(' ')
      if (cmd === 'rev-parse --show-toplevel') return '/repo\n'
      if (cmd === 'pr view 7 --json baseRefName,headRefName,url') return '{"baseRefName":"main","headRefName":"feat/otp","url":"https://github.com/swile/app/pull/7"}'
      if (cmd.startsWith('fetch --quiet origin ')) return ((fetched = cmd.endsWith('pull/7/head') ? 'headsha' : 'basesha'), '')
      if (cmd === 'rev-parse FETCH_HEAD') return fetched
      if (cmd === 'merge-base basesha headsha') return 'mbsha\n'
      if (cmd === 'diff --name-only -z mbsha headsha --') return 'src/pages/login.tsx\0src/gone.ts\0'
      if (cmd === 'show headsha:src/pages/login.tsx') return "import { start } from '../auth/session'\n"
      if (cmd === 'show headsha:src/gone.ts') return ''
      if (cmd.startsWith('diff -U3 mbsha headsha')) return '@@ -1 +1 @@\n-old\n+new\n'
      return undefined
    }
    const { runs, writes, clock } = engine(on, { git })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    const r = await $.command.run({ command: 'mission', args: '#7' } as any)
    expect(r.text).toMatch(/review: 1 changed files against PR #7 \(main\)/) // the file the PR deletes is left out
    expect(runs.some(a => a[0] === 'git' && a.includes('checkout'))).toBe(false) // the working tree is not touched
    await clock.advance(1600)
    expect(writes['/tmp/mission-control/s/data.js'] ?? '').toContain('"id":"/repo/src/pages/login.tsx"')
    expect(writes['/tmp/mission-control/s/diffs.js']).toContain('@@ -1 +1 @@') // read from the fetched commits
    expect(writes['/tmp/mission-control/s/data.js']).toContain('"where":{"branch":"feat/otp","base":"main","pr":{"number":7,"url":"https://github.com/swile/app/pull/7"}}')
    expect((await $.command.run({ command: 'mission', args: '#8' } as any)).text).toMatch(/gh could not read pull request #8/)
  })
  test('a diff is parsed into numbered rows, and comments are quoted for the clipboard', () => {
    const patch = ['diff --git a/x.ts b/x.ts', 'index 1..2 100644', '--- a/x.ts', '+++ b/x.ts', '@@ -3,4 +3,4 @@ fn', ' keep', '--- gone', '-old', '+new', '+extra', ' tail', '\\ No newline at end of file'].join('\n')
    const rows = parseDiff(patch)
    expect(rows.map(r => `${r.k}${r.o ?? ''}/${r.n ?? ''}:${r.t}`)).toEqual(['h/:@@ -3,4 +3,4 @@ fn', 'c3/3:keep', 'd4/:-- gone', 'd5/:old', 'a/4:new', 'a/5:extra', 'c6/6:tail'])
    expect(parseDiff('@@ -1 +1 @@\n-a\n+b').map(r => r.k)).toEqual(['h', 'd', 'a']) // a GitHub patch has no file headers
    expect(parseDiff('@@ -0,0 +1,2 @@\n+a\n+b\n@@ -9 +9 @@\n-c\n+d').map(r => r.n ?? r.o)).toEqual([undefined, 1, 2, undefined, 9, 9])
    expect(parseDiff('')).toEqual([])
    expect(addedDiff('a\nb\n')).toBe('@@ -0,0 +1,2 @@\n+a\n+b')
    expect(parseDiff(addedDiff('a\nb\n')).filter(r => r.k === 'a').map(r => r.n)).toEqual([1, 2])
    expect(addedDiff('')).toBe('')

    const body = rows.filter(r => r.k !== 'h') // keep, gone, old, new, extra, tail
    expect(formatComment('src/x.ts', body.slice(2, 4), 'why both?')).toBe('src/x.ts:L4\n> -old\n> +new\n\nwhy both?')
    expect(formatComment('src/x.ts', body.slice(2, 5), 'rename')).toBe('src/x.ts:L4-5\n> -old\n> +new\n> +extra\n\nrename')
    expect(formatComment('src/x.ts', body.slice(1, 3), 'drop')).toBe('src/x.ts:L4-5 (removed)\n> --- gone\n> -old\n\ndrop') // only old lines: their old numbers
    expect(formatComment('src/x.ts', body.slice(1, 4), 'mixed')).toBe('src/x.ts:L4\n> --- gone\n> -old\n> +new\n\nmixed') // the new side's numbers win
    const long = Array.from({ length: 15 }, (_, i) => ({ k: 'a' as const, n: i + 1, t: `l${i}` }))
    expect(formatComment('f.ts', long, 'big')).toContain('> … 3 more lines')
    expect(formatReview([{ path: 'a.ts', lines: body.slice(3, 4), text: 'one' }, { path: 'b.ts', lines: body.slice(4, 5), text: 'two' }], 'PR #9 (main)')).toBe(
      'Code review comments on PR #9 (main) (2):\n\na.ts:L4\n> +new\n\none\n\n---\n\nb.ts:L5\n> +extra\n\ntwo',
    )
    expect(formatReview([{ path: 'a.ts', lines: long.slice(0, 1), text: 'x' }], '')).toMatch(/^Code review comments \(1\):/)
  })

  test('diff lines are tinted by what they are: keywords, strings, comments, numbers, types', () => {
    const kinds = (text: string, ext: string) => highlight(text, ext).filter(([k]) => k).map(([k, t]) => `${k}:${t}`)
    expect(kinds('export const TTL = 3600 // an hour', 'ts')).toEqual(['kw:export', 'kw:const', 'type:TTL', 'num:3600', 'com:// an hour'])
    expect(kinds("import { Foo } from './x' + \"a // b\"", 'tsx')).toEqual(['kw:import', 'type:Foo', 'kw:from', "str:'./x'", 'str:"a // b"']) // a // inside a string is no comment
    expect(kinds('  * @param x the thing', 'ts')).toEqual(['com:  * @param x the thing']) // inside a block comment
    expect(kinds('def run # go', 'rb')).toEqual(['kw:def', 'com:# go'])
    expect(kinds('SELECT 1 -- one', 'sql')).toEqual(['type:SELECT', 'num:1', 'com:-- one'])
    expect(highlight('# Title', 'md')).toEqual([['', '# Title']]) // prose is left alone
    expect(highlight('plain words', 'ts').map(([, t]) => t).join('')).toBe('plain words') // nothing is lost between pieces
    expect(highlight('', 'ts')).toEqual([])
  })

  test('highlight.js is fed each hunk as the new and as the old file, and its spans are cut line by line', () => {
    // A stand-in that wraps the word "x" in a span and a back-quoted string (which may run over lines) in another.
    const hljs = {
      highlight: (code: string) => ({
        value: code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`[^`]*`/g, m => `<span class="hljs-string">${m}</span>`).replace(/\bx\b/g, '<span class="hljs-keyword">x</span>'),
      }),
    }
    const rows = parseDiff(['@@ -1,3 +1,3 @@', ' const a = `one', '-two` + x', '+two` + y', ' tail x', '@@ -9 +9 @@', '-<b>', '+x'].join('\n'))
    const html = htmlRows(rows, 'typescript', hljs)
    expect(html[0]).toBeUndefined() // a hunk header is no code
    expect(html[1]).toBe('const a = <span class="hljs-string">`one</span>') // the string still opens here, closed at the cut
    expect(html[2]).toBe('<span class="hljs-string">two`</span> + <span class="hljs-keyword">x</span>') // a deleted line, read in the old file: the string reopens
    expect(html[3]).toBe('<span class="hljs-string">two`</span> + y') // an added line, read in the new file
    expect(html[4]).toBe('tail <span class="hljs-keyword">x</span>')
    expect(html[5]).toBeUndefined()
    expect(html[6]).toBe('&lt;b&gt;') // text is escaped before it reaches innerHTML
    expect(html[7]).toBe('<span class="hljs-keyword">x</span>')
    expect(htmlRows(rows, 'typescript', { highlight: () => { throw new Error('unknown language') } }).every(h => h === undefined)).toBe(true) // the page falls back to the small tint
    expect([langOf('tsx'), langOf('RB'), langOf('yml'), langOf('toml'), langOf('exs'), langOf('')]).toEqual(['typescript', 'ruby', 'yaml', 'ini', '', ''])
  })

  test('the page script carries the same diff code the tests check', () => {
    const scripts = [...TEMPLATE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1] as string)
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain(parseDiff.toString())
    expect(scripts[0]).toContain(formatReview.toString())
    expect(scripts[0]).toContain(highlight.toString())
    expect(scripts[0]).toContain(htmlRows.toString())
    expect(TEMPLATE).toContain('<script src="hljs.js"></script>')
    expect(TEMPLATE).toContain('<div id="drawer" hidden>')
  })

  test('files are framed by what they are for', () => {
    const kinds: Record<string, string> = {
      '/r/src/login.tsx': 'Source',
      '/r/src/login.test.tsx': 'Tests',
      '/r/spec/models/user_spec.rb': 'Tests',
      '/r/src/__tests__/helpers.ts': 'Tests',
      '/r/config/locales/fr.yml': 'Translations',
      '/r/src/i18n/en.json': 'Translations',
      '/r/db/migrate/20240101_add_otp.rb': 'Database',
      '/r/src/types.d.ts': 'API & contracts',
      '/r/.env.local': 'Config & env',
      '/r/vite.config.ts': 'Config & env',
      '/r/config/settings.yml': 'Config & env',
      '/r/package.json': 'Dependencies',
      '/r/Gemfile.lock': 'Dependencies',
      '/r/.github/workflows/ci.yml': 'CI & infra',
      '/r/Dockerfile': 'CI & infra',
      '/r/README.md': 'Docs',
      '/r/src/app.scss': 'Styles',
      '/r/config/locales/fr.spec.yml': 'Tests', // the first rule wins: a spec is a test wherever it sits
    }
    for (const [path, kind] of Object.entries(kinds)) expect([path, categoryOf(path)]).toEqual([path, kind])

    const f = (path: string, imports: string[] = []) => ({ path, act: 'edit' as const, at: 0, changedTurn: 1, imports })
    const out = mapData([f('/r/src/login.tsx', ['/r/src/session']), f('/r/src/session.ts'), f('/r/src/login.test.tsx', ['/r/src/login']), f('/r/.env.local')], { at: 99_999, turn: 1 })
    expect(out.groups.map(g => [g.name, g.columns.flat().map(c => c.title)])).toEqual([
      ['Source', ['login.tsx', 'session.ts']],
      ['Tests', ['login.test.tsx']],
      ['Config & env', ['.env.local']],
    ])
    expect(out.edges.map(e => `${e.from}>${e.to}`)).toContain('/r/src/login.test.tsx>/r/src/login.tsx') // arrows still cross frames
    expect(mapData([f('/r/a.ts')], { at: 99_999, turn: 1 }).groups).toHaveLength(1) // one kind only: the page draws no frame
  })
})
