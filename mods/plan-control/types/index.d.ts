// What the band above the prompt shows: the map's state, refreshed each time the map is rebuilt.
export type Band = {
  title: string
  tickets: number
  done: number
  ready: number // not done, and every blocker on the map is done
  reading: number // Obeya tickets still being read
  mismatches: number
  link: string // the page's address while its server runs, else ''
}

declare module 'claude-code' {
  interface PluginState {
    'plan-control': {
      band: Band
    }
  }
}
