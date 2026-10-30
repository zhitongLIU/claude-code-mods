---
id: PC-2
status: done
---

# Capture Obeya reads through tool.call

## Contract

**Service:** plan-control
**Blocked by:** PC-1

### Provides

- `db plan-control cache/obeya/<KEY>.md`
  ```diff
  + the raw obeya_get_task_context result, shared by every session
  ```

### Consumes

- `db plan-control maps/<session id>.json` from PC-1
  ```diff
  + sources: { ref, kind, children, addedAt }[]
  ```

## Plan

A mod cannot call an MCP server: ask Claude to read the ticket, and keep the result as it passes the
`tool.call` hook. A call to `obeya_write_plan` marks the ticket stale.
