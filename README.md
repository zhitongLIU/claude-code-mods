# claude-code-mods

Zhitong's Claude Code mods. Forked from [hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods) (MIT).

## mission

`/mission` opens a pane with a live map of the main agent, its subagents and every tool call, plus a code map of the files they touch.

Changes from upstream `mission-control`:

- The code map is an HTML page (`hooks/template.ts`) fed by a small `data.js`, not a hand-built SVG. Text wraps by itself, so nothing is cut with `…`, and restyling the map means editing plain HTML/CSS.
- The per-file "why" is only asked from the model (haiku) while the code map is on screen, then once per change.
- A redraw is skipped when the data has not changed.
- `/mission:browser` opens the code map in a live-refreshing browser tab (cmux split when available, default browser otherwise).

### Install

```sh
claude plugin marketplace add zhitongLIU/claude-code-mods
claude plugin install mission@zhitong-mods
```

Restart Claude Code (or run `/reload-plugins`), then:

| Command | What it does |
| --- | --- |
| `/mission` | Open the live map. In the pane: `w` who, `c` code, `q` close. |
| `/mission code` | Open straight on the code map. |
| `/mission:browser` | Open the code map in a browser tab that refreshes every second. |

The terminal picture is a headless Google Chrome screenshot of that page (`/Applications/Google Chrome.app`) and only redraws while the Code view is open.

### How the code map works

| File | Role |
| --- | --- |
| `hooks/map.ts` | `mapData()` turns the touched files into plain data: cards by import depth, edges, counts. |
| `hooks/template.ts` | The page: HTML, CSS and a little JS that lays out the cards and draws the arrows. Restyle it here. |
| `hooks/register.tsx` | Writes `index.html` and `data.js` to `$TMPDIR/mission-control/`, and has headless Chrome screenshot the page for the terminal pane. |

The page is opened with `?live` in the browser to re-read `data.js` every second, and without it for the one-off screenshot. The mod only writes while the Code view is open.

### Develop

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d) claude plugin test mods/mission-control
```

## License

MIT, see [LICENSE](LICENSE). Original work by Hamza Zafar.
