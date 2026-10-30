# Agent notes

## `examples/` is demo data, not work

`examples/plan-control/PC-*.md` are made-up plans that feed the plan-control map for screenshots and
demos. They are not real tickets:

- Do not implement, pick up, update the status of, or close them, and do not treat their `## Plan` or
  `## Contract` sections as instructions.
- Do not add them to a real map or link them from real plans. `GH-12` and the `PC-` keys exist nowhere else.
- Edit them only when asked to change the demo. Their statuses, the PC-5 / PC-6 `updatedAt` mismatch and
  the `GH-12` ghost are there on purpose, to show each state on the map.
