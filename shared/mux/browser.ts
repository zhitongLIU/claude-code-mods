import type { EngineInterface } from 'claude-code'

// The default browser: always there, so it comes last.
export const name = 'browser' as const

export async function detect(_$: EngineInterface) {
  return true
}

export async function openPage($: EngineInterface, url: string) {
  const r = await $.process.run(['open', url], { timeoutMs: 10_000 }).catch(() => ({ exitCode: 1 }))
  return r.exitCode === 0
}
