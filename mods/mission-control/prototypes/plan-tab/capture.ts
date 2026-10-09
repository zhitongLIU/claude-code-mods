// PostToolUse hook: saves every obeya_get_task_context result Claude reads to the plan cache, so
// build.ts can redraw the Plan tab from disk without Claude re-reading or re-writing anything.
//   cache: $MISSION_PLAN_CACHE or ~/.cache/mission-plan/obeya/<KEY>.md
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CACHE = process.env.MISSION_PLAN_CACHE ?? join(homedir(), '.cache', 'mission-plan', 'obeya')

// An MCP tool result reaches the hook as a string, an array of content blocks, or { content: [...] }.
function textOf(response: unknown): string {
  if (typeof response === 'string') return response
  if (Array.isArray(response)) return response.map(textOf).join('\n')
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>
    if (typeof r.text === 'string') return r.text
    if (r.content !== undefined) return textOf(r.content)
  }
  return ''
}

try {
  const event = JSON.parse(readFileSync(0, 'utf8')) as { tool_input?: { taskKey?: unknown; for?: unknown }; tool_response?: unknown }
  const key = String(event.tool_input?.taskKey ?? '')
  const text = textOf(event.tool_response)
  // Only the 'implement' view carries the current plan; a 'review' read shows the approved one.
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(key) && text.includes('## 1. IDENTITY') && event.tool_input?.for !== 'review') {
    mkdirSync(CACHE, { recursive: true })
    writeFileSync(join(CACHE, `${key}.md`), text)
  }
} catch {
  // a hook never blocks the tool call it watches
}
