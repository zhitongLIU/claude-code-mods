---
name: browser
description: Open the Mission Control code map in a browser (cmux preferred), auto-refreshing and full-size. Use when the user wants the /mission code map larger or in a browser.
disable-model-invocation: true
---

Open the code map page the mod writes (`index.html` + `data.js`). With `?live` it re-reads the data every second, so nothing needs refreshing. Prefer cmux; fall back to the system browser.

1. Build the URL and check the page exists:

```sh
DIR="${TMPDIR:-/tmp}"; DIR="${DIR%/}/mission-control"
URL="file://$DIR/index.html?live"
[ -s "$DIR/index.html" ] || echo "no map yet: run /mission and press c for the Code view"
```

2. If there is no map yet, tell the user to run `/mission`, press `c`, then retry. Stop.

3. If `cmux` is on PATH and `$CMUX_WORKSPACE_ID` is set: `cmux browser open-split "$URL" --focus true`.

4. Otherwise: `open "$URL"`.

The mod only rewrites `data.js` while the Code view is open in `/mission`; if the page looks frozen, press `c` in the pane.

Reply with one line: where it opened and the URL.
