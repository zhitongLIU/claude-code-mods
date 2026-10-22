// One box in the "who" tree: the main loop, a subagent, or one tool call.
export type MissionNode = {
  id: string
  parent: string | null
  kind: 'main' | 'agent' | 'tool'
  label: string
  family: string // for tools: 'bash', 'edit', 'read', 'browser', 'mcp:<server>', ...
  status: 'running' | 'done' | 'failed'
  start: number
  end?: number
}

// One file in the code map.
export type MapFile = {
  path: string
  act: 'read' | 'edit' | 'write' | 'search'
  at: number
  changedTurn: number // the turn number it last changed in, 0 if never
  imports: string[] // resolved import targets, extension stripped
  names?: string[] // class and module names the file mentions, for languages that link by name
  why?: string
  edits?: string[] // what its last turn changed, kept until the one-line why is asked for
  editsTurn?: number // the turn those edits belong to
  review?: boolean // put on the map by /mission review: shown as changed until the next turn
}

// One problem an AI review found, drawn pink on the file's box and under its line in the diff drawer.
export type Finding = {
  file: string // repo-relative, or the map's own path
  line?: number // 1-indexed, in the new version of the file
  summary: string
  scenario?: string
  severity?: string
  posted?: boolean // already pushed to the pull request
  stale?: boolean // the file was edited after the review, so the line may have moved or the problem may be fixed
  dismissed?: boolean // the reviewer put it away: nothing shows it
}

// What the page is looking at: the branch, what it is compared with, and its pull request.
export type MissionWhere = { branch: string; base?: string; pr?: { number: number; url: string } }

declare module 'claude-code' {
  interface PluginState {
    mission: {
      nodes: MissionNode[]
      files: MapFile[]
      turn: number
      sid: string
      diffs: Record<string, { text: string; ref?: string }>
      where: MissionWhere
      findings: Finding[]
    }
  }
}
