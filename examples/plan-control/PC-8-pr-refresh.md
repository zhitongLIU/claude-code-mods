---
id: PC-8
status: planning
---

# Pull request state on the clock

## Contract

**Service:** plan-control
**Blocked by:** PC-1, GH-12

### Provides

none

### Consumes

- `env plan-control PLAN_CONTROL_GITHUB_ORG` (existing, unchanged)
- `db plan-control maps/<session id>.json` from PC-1
  ```diff
  + sources: { ref, kind, children, addedAt }[]
  ```

## Plan

`gh pr list` on `$PLAN_CONTROL_GITHUB_ORG/<service>` once a minute while the page is open, matched on
the ticket key in the branch name. Waits on GH-12 (`gh` signed in on CI).
