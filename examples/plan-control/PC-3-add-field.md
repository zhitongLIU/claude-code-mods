---
id: PC-3
status: in_review
---

# + Add field and add / remove over the local server

## Contract

**Service:** page
**Blocked by:** PC-1

### Provides

- `http plan-control POST /<token>/add`
  ```diff
  + text: string
  ```
- `http plan-control POST /<token>/remove`
  ```diff
  + id: string
  ```

### Consumes

- `db plan-control maps/<session id>.json` from PC-1
  ```diff
  + sources: { ref, kind, children, addedAt }[]
  ```

## Plan

The page header takes a key, a link or a path and posts it to the mod, the way **Send to Claude** does.
