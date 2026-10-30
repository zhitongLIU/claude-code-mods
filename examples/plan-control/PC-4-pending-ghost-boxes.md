---
id: PC-4
status: in_dev
---

# Pending and ghost boxes

## Contract

**Service:** page
**Blocked by:** PC-2, PC-3

### Provides

none

### Consumes

- `http plan-control POST /<token>/add` from PC-3
  ```diff
  + text: string
  ```
- `db plan-control cache/obeya/<KEY>.md` from PC-2
  ```diff
  + the raw obeya_get_task_context result, shared by every session
  ```

## Plan

A ticket not read yet shows "loading…". A blocker the map does not hold is a dashed ghost with
**+ add**; a ghost that is a plan file next to one on the map opens that file.
