# plan-control — design

A mod that draws a map of the tickets of one piece of work: Obeya tickets and local plan files, the
dependencies between them, the interfaces each provides and consumes, their pull requests, and which
cmux tab is working on each one right now. It runs in the **global agent tab**; `mission` keeps running
in each ows tab. Prototype: `mods/mission-control/prototypes/plan-tab/`.

## Why a separate mod

| | mission | plan-control |
|---|---|---|
| Scope | one session, one worktree | many tickets, many worktrees |
| Runs in | each ows tab | the global agent tab |
| Changes when | Claude reads or edits a file | a ticket, plan or PR changes |

The two meet only through the **mission registry** (below). Neither imports the other.

## Commands

| Command | What it does |
|---|---|
| `/plan-control` | Open the map page for this session's map (empty the first time). |
| `/plan-control add <ref> [<ref> …]` | Add tickets to the map, while the page is open or not. |
| `/plan-control remove <id>` | Take a ticket off the map. |
| `/plan-control refresh` | Re-read every source (stale Obeya tickets, changed files, PRs). |
| `/plan-control maps` | List the saved maps of every session. |
| `/plan-control attach <map>` | Make this session use a saved map (after a restart). |
| `/plan-control off` | Stop the page and its server. |

`<ref>` is one of:

| Ref | Adds |
|---|---|
| `CAO-219` (Obeya key of a parent ticket) | the ticket and all its sub-tickets |
| `CAO-223` (Obeya key of a leaf ticket) | that ticket only |
| `CAO-219 --only` | the parent alone, without its sub-tickets |
| `https://obeya.example.com/tasks/CAO-223` | same as its key |
| `path/to/plan.md` | one local plan file (`.loop/tasks/*.md`, `.tasks/*.md`, speckit `plan.md`, any `.md` with a `## Contract` header) |
| `path/to/dir/` | every plan file in it, not recursive |

The page has the same entry: a **+ Add** field in its header takes a key, a link or a path, and sends it
to the mod over the local server (`POST /<token>/add`), the way "Send to Claude" does.

## Adding a ticket

**Local file.** The mod reads the file itself; no model call. The id is the frontmatter `id`, else a
ticket key in the file name, else the file name. Status, service and blockers come from the
frontmatter (`status`, `service`, `blocked_by`) and the `## Contract` header. The mod re-reads a
file when its modification time changes (checked on the 1-second clock, and at once when Claude
edits it through Edit or Write).

**Obeya ticket.** A mod cannot call an MCP server, so:

1. The mod puts a **pending** box on the map (key only, "loading…").
2. It submits a short prompt with `$.prompt.submit`: read `<KEY>` with
   `obeya_get_task_context` (`for: "implement"`), and do nothing else.
3. Its `tool.call` hook on `mcp__obeya__obeya_get_task_context` takes the raw result as it passes,
   parses it (`lib/contract.ts`) and fills the box. Claude writes nothing back, so the cost is the
   tokens of reading that one plan.
4. For a parent ticket, step 2 lists its sub-tickets, and the mod asks for each one not cached yet.

The same hook catches every `obeya_get_task_context` the session makes for a ticket on the map, so
a plan Claude reads for any other reason refreshes its box for free. A call to `obeya_write_plan`
for a ticket on the map marks that ticket stale, and the mod asks for it again after the turn ends.

## Ghost tickets

A ticket on the map can name a blocker or a provider that is not on the map (`Blocked by: CAO-222`
when only CAO-225 was added). The mod draws it as a **ghost**: a dashed box with its key and a
**+ add** button. Edges into a ghost are drawn, but the ghost's status is unknown, so the edge is not
counted as unlocked. Adding the ghost turns it into a real box.

## Storage

Everything lives under `~/.plan-control/`, never in the working folder:

```text
~/.plan-control/
├── maps/<session id>.json     # one map per Claude session
├── cache/obeya/<KEY>.md       # captured obeya_get_task_context results, shared by all sessions
└── extracted/<KEY>.json       # contracts extracted once from plans without a Contract header, shared
```

**One map per session.** Several epics run at the same time, each in its own global tab, so each
Claude session has its own map, named by its session id (the id `session.start` gives, as mission
uses). Adding a ticket in one tab never shows it in another. The cache and the extracted contracts
are shared: they describe tickets, not maps, and a ticket read in one session is not read again in
another.

**Getting a map back.** A session that starts again with a new id starts with an empty map.
`/plan-control maps` lists the saved maps (title, tickets, last change), and
`/plan-control attach <map>` makes this session use one of them; the old session's file is renamed to
the new id, so two live sessions never share a map. A map's title is the first parent ticket added
(`CAO-219 · Deferred payment for private customers`), else the first ticket. Maps untouched for 30 days
are deleted on start.

A map file:

```json
{
  "title": "CAO-219 · Deferred payment for private customers",
  "cwd": "/path/to/workspaces/deferred-payment",
  "updatedAt": "2026-10-28T10:20:00Z",
  "sources": [
    { "ref": "CAO-219", "kind": "obeya", "children": true, "addedAt": "2026-10-28T10:12:00Z" },
    { "ref": ".loop/tasks/T-4-orders-api-refund-fields.md", "kind": "file", "addedAt": "…" }
  ],
  "positions": {}
}
```

Ticket contents are not kept in the map: Obeya tickets come from the cache and files are read from
disk. A ticket's entry in `extracted/` is used only while its plan has no Contract header. `positions`
holds the boxes the user dragged, so they survive a restart.

## Mission registry

Each `/mission` page writes one file, and removes it on `/mission off`:

`$TMPDIR/mission-control/registry/<sid>.json`

```json
{ "sid": "…", "cwd": "/path/to/workspaces/deferred-payment/CAO-223-otp", "branch": "cao-223-orders-api-otp-verification",
  "url": "http://127.0.0.1:…/<token>/", "updatedAt": 1793183000000,
  "summary": { "changed": 3, "agentsRunning": 1, "now": "editing order.rb" } }
```

plan-control reads the registry every second. It matches a session to a ticket by the ticket key in
`branch`, then in the ows folder name of `cwd`. A matched ticket gets a **live** dot, the summary line,
and a link to that session's mission page. A registry file not updated for 30 seconds counts as gone.

Clicking a live ticket focuses its cmux tab (`cmux` CLI, as `ows` opens tabs); outside cmux the link
opens the mission page.

## The page

As the prototype, plus:

- the **+ Add** field, pending and ghost boxes, a **live** dot;
- several parent tickets on one map: lanes stay one per service, and a chip per parent ticket filters to it;
- local tickets link to their file (`vscode://file/…`), Obeya tickets to
  `https://obeya.example.com/tasks/<KEY>`, pull requests to GitHub;
- links whose blocker is done are green (unlocked); mismatched interfaces are red;
- **Send to Claude** on selected mismatches submits the fix prompt to the global session.

## Out of scope

- Editing plans from the page (Claude does it, after you confirm).
- Calling Obeya without Claude. If Obeya offers a personal API token later, the fetch in "Adding a
  ticket" moves into the mod and stops costing tokens; nothing else changes.
- Type and enum comparison of interface fields (names only at first).

## Build order

1. Move the prototype into `mods/plan-control/`: `/plan-control`, page server, `lib/contract.ts`,
   the capture hook as `tool.call`, local files, per-session maps under `~/.plan-control/`
   (`maps`, `attach`), the cache moved from `~/.cache/mission-plan/`. Remove the `PostToolUse` hook from
   the planning repo's `.claude/settings.json`.
2. `add` / `remove` (command and page field), pending and ghost boxes.
3. Mission registry (mission writes, plan-control reads), live dots, focusing the cmux tab.
4. Send mismatches to Claude, PR state refresh on the clock.
