---
id: PC-1
status: done
---

# Move the prototype into mods/plan-control

## Contract

**Service:** plan-control
**Blocked by:** none

### Provides

- `db plan-control maps/<session id>.json`
  ```diff
  + title: string
  + cwd: string
  + sources: { ref, kind, children, addedAt }[]
  + positions: Record<key, { x, y }>
  ```

### Consumes

none

## Plan

Move `/plan-control`, the page server and `lib/contract.ts` out of the prototype. One map per Claude
session under `~/.plan-control/maps/`, `maps` and `attach` to take one back after a restart.
