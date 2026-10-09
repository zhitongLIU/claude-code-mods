# claude-code-mods

Zhitong's Claude Code mods. Forked from [hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods) (MIT).

## mission

`/mission` opens a pane with a live map of the main agent, its subagents and every tool call, plus a code map of the files they touch.

Changes from upstream `mission-control`:

- Code map cards wrap the full "why" text instead of cutting it with `…`.
- `/mission:browser` opens the code map in a live-refreshing browser tab (cmux split when available, default browser otherwise).

### Install

```sh
claude plugin marketplace add zhitongLIU/claude-code-mods
claude plugin install mission@zhitong-mods
```

Restart Claude Code, then:

| Command | What it does |
| --- | --- |
| `/mission` | Open the live map. In the pane: `w` who, `c` code, `q` close. |
| `/mission code` | Open straight on the code map. |
| `/mission:browser` | Open the code map in a browser tab that refreshes every second. |

The code map is drawn with Google Chrome (`/Applications/Google Chrome.app`) and only redraws while the Code view is open.

### Develop

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d) claude plugin test mods/mission-control
```

## License

MIT, see [LICENSE](LICENSE). Original work by Hamza Zafar.
