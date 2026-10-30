---
id: PC-7
status: ready-for-agent
---

# Send mismatches to Claude

## Contract

**Service:** page
**Blocked by:** PC-1

### Provides

- `http plan-control POST /<token>/send`
  ```diff
  + prompt: string
  ```

### Consumes

none

## Plan

Tick mismatches in **Mismatches ›**, pick the side to fix, and submit the fix prompt to the global
session. Claude edits no plan until you confirm.
