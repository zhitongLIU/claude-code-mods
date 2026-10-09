# claude-code-mods

Zhitong's Claude Code mods. Forked from [hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods) (MIT).

## mission

`/mission` opens a live web page with two tabs, **Who** (the main agent, its subagents and every tool call) and **Code** (a map of the files Claude reads and edits, the imports between them, and one line on why each changed). The page refreshes itself every second. There is no side pane.

It opens in a cmux browser split when run inside cmux, otherwise in your default browser.

Changes from upstream `mission-control`:

- The terminal pane is gone: `/mission` opens the web page. No Chrome screenshot is needed any more.
- The page (`hooks/template.ts`) is plain HTML and CSS fed by a small `data.js`, not a hand-built SVG. Text wraps by itself, so nothing is cut with `…`, and restyling means editing HTML/CSS.
- The per-file "why" is asked from the model (haiku) only once `/mission` has opened the page, then once per change.
- Nothing is written until `/mission` runs, and `/mission off` stops it. Writes are skipped when the data has not changed.
- Arrows come from per-language adapters (`hooks/lang.ts`): JS/TS and Python follow relative imports, Ruby follows `require_relative` and the class or module names a file mentions (`RequestChorusOtp` links to `request_chorus_otp.rb`), as Rails loads code by name. Add a language by adding an adapter.
- Each session has its own page folder, so several Claude Code sessions can run `/mission` side by side without sharing data.
- Kept from upstream: the one-line band above the prompt while Claude works.

### Install

```sh
claude plugin marketplace add zhitongLIU/claude-code-mods
claude plugin install mission@zhitong-mods
```

Restart Claude Code (or run `/reload-plugins`), then:

| Command | What it does |
| --- | --- |
| `/mission` | Open the page on the Who tab and keep it updated. |
| `/mission code` | Open the page on the Code tab. |
| `/mission off` | Stop updating the page. |

In the page: `w` Who, `c` Code. The tab is kept in the URL hash (`#who`, `#code`).

Closing the browser tab does not stop the updates, because the mod cannot see it close. Run `/mission off` when you are done, which also stops the model calls for the "why" lines.

### How it works

| File | Role |
| --- | --- |
| `hooks/register.tsx` | Tracks agents, tool calls and files. After `/mission`, writes `index.html` once and `data.js` on every change to `$TMPDIR/mission-control/<session id>/`, and opens the page. |
| `hooks/lang.ts` | Language adapters: what each file links to, and which names it defines. |
| `hooks/map.ts` | `mapData()` turns the touched files into plain data: cards by link depth, edges, counts. |
| `hooks/tree.ts` | The Who tree lines. |
| `hooks/template.ts` | The page: tabs, the tree, the card layout and the arrows. Restyle it here. |

### Develop

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d) claude plugin test mods/mission-control
```

## License

MIT, see [LICENSE](LICENSE). Original work by Hamza Zafar.
