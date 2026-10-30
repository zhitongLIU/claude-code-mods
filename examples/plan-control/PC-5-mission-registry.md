---
id: PC-5
status: in_dev
---

# Mission writes its registry file

## Contract

**Service:** mission
**Blocked by:** none

### Provides

- `db mission registry/<sid>.json`
  ```diff
  + sid: string
  + cwd: string
  + branch: string
  + url: string
  + summary: { changed, agentsRunning, now }
  ```

### Consumes

none

## Plan

Each `/mission` page writes `$TMPDIR/mission-control/registry/<sid>.json` and removes it on
`/mission off`. Neither mod imports the other.
