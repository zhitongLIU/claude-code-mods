---
name: plan-contract
description: Write the `## Contract` section of a plan (an Obeya plan, a .loop/tasks or .tasks file, a speckit plan.md) so plan-control can draw its dependencies and catch interface mismatches between plans. Use when writing or editing a plan that depends on other tickets, or that adds, changes or reads an API, topic, table, file, flag or email another plan touches; or when the user asks to "add a contract", "write the interfaces" or fix "unread" lines shown on the plan-control map.
---

# Plan contract

Every plan that depends on another ticket, or provides or reads an interface another plan touches, ends its header with a `## Contract` section. plan-control reads it to draw edges and to flag a field a consumer reads that its provider never adds.

## Format

```markdown
## Contract
**Service:** mission · **Blocked by:** PC-4, PC-2
- **provides** `db mission registry/<sid>.json` `{ sid, cwd, branch, summary{changed, now} }`
- **consumes** `http admin-bff GET /session` from PC-2 `{ updatedAt:number }`
- **consumes** `kafka orders.created` existing
```

- **Service:** the repo or service the plan changes. **Blocked by:** the ticket keys that must be done first, or `none`. Both can share one line.
- One bullet per interface, starting with `- **provides**` or `- **consumes**`.
- The interface id goes in backticks: the kind first (`http`, `kafka`, `db`, `graphql`, `email`, `flag`), then the service and a stable name. For http, write the method and path: `http orders-api GET /orders/:id`.
- A consumed interface says where it comes from: `from KEY` (a ticket on the map), or `existing` (already in production, never checked).
- The fields go in a second pair of backticks, in braces, separated by commas:
  - `name` or `name:type` (`updatedAt:number`, `terms:integer|null`)
  - `-name`: the provider removes the field; `~name`: it changes the field
  - `parent{a, b}`: nested fields, read as `parent.a` and `parent.b`
- A provider lists every field it adds or changes. A consumer lists every field it reads. Leave the braces out only when there is nothing to compare.
- A plan that spans several services has one `## Contract — <service>` section each.
- To set the contract apart, you can put its lines in a `>` quote (`> **Service:** …`, `> - **provides** …`). Obeya and GitHub draw it with a grey bar; the map reads it the same.

## Rules that make the checks work

1. **Copy the provider's id exactly.** Before you write a `consumes` line, read the provider's plan (`obeya_get_task_context <KEY>` or its file) and copy its id character for character. `db registry/<sid>.json` and `db mission registry/<sid>.json` are two different interfaces to the map.
2. **Name fields the same way on both sides.** A consumer's `summary.changed` matches a provider's `summary{changed}`, and `changed` alone matches `summary.changed`, but `summaryChanged` does not.
3. **Keep everything on one line per interface.** Obeya joins lines and does not render `>` callouts, `:::` blocks or code fences, so the bullet must carry the whole interface.
4. **Write nothing else as a bullet in the Contract section.** Notes go in the plan body. A bullet the map cannot read shows as **⚑ unread** on the ticket's box, and the box lists the line.

## After writing

Open the map (`/plan-control`) and click the ticket: its Provides and Consumes should list every interface you wrote, with no **Lines not read** section. A pink edge means a consumer reads a field its provider does not list: fix whichever plan is wrong.
