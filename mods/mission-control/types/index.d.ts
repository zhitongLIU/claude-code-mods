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
}

declare module 'claude-code' {
  interface PluginState {
    mission: {
      nodes: MissionNode[]
      files: MapFile[]
      turn: number
      sid: string
    }
  }
}
