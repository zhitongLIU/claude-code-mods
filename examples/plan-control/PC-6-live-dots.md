---
id: PC-6
status: todo
---

# Live dots and focusing the cmux tab

## Contract

**Service:** plan-control
**Blocked by:** PC-4, PC-5

### Provides

none

### Consumes

- `db mission registry/<sid>.json` from PC-5
  ```diff
  + branch: string
  + summary: { changed, agentsRunning, now }
  + updatedAt: number
  ```

## Plan

Read the registry every second, match a session to a ticket by the key in its branch, and show a
**live** dot with its summary. A registry file not updated for 30 seconds counts as gone.
