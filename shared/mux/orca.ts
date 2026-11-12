import type { EngineInterface } from 'claude-code'

import { openPage as openInBrowser } from './browser'

// A tab of Orca's own browser.
export const name = 'orca' as const

const APP_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'

export async function detect($: EngineInterface) {
  return Boolean(await $.env.get('ORCA_TERMINAL_HANDLE'))
}

// Where the orca CLI may be, in the order tried: $ORCA_CLI_BIN_DIR, then PATH, then inside the app
// (Orca does not always put its CLI on PATH).
async function clis($: EngineInterface) {
  const dir = ((await $.env.get('ORCA_CLI_BIN_DIR')) ?? '').replace(/\/$/, '')
  return [...new Set([...(dir ? [`${dir}/orca`] : []), 'orca', APP_CLI])]
}

// Where no orca CLI runs, or it fails, the default browser opens the page.
export async function openPage($: EngineInterface, url: string) {
  for (const cli of await clis($)) {
    const r = await $.process.run([cli, 'tab', 'create', '--url', url, '--json'], { timeoutMs: 10_000 }).catch(() => undefined)
    if (!r || r.exitCode === 127) continue // not there: the next place
    if (r.exitCode === 0) return true
    break // it ran and failed
  }
  return openInBrowser($, url)
}
