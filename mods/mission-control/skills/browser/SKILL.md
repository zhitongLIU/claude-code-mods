---
name: browser
description: Open the Mission Control code map in a browser (cmux preferred), auto-refreshing and full-size. Use when the user wants the /mission code map larger or in a browser.
disable-model-invocation: true
---

Open a self-refreshing page that shows the Mission Control code map. Prefer cmux; fall back to the system browser.

1. Write the live page next to the map (it reloads `map.svg` every second, no flicker, scales to the window):

```sh
DIR="${TMPDIR:-/tmp}"; DIR="${DIR%/}/mission-control"
mkdir -p "$DIR"
cat > "$DIR/live.html" <<'EOF'
<!doctype html>
<meta charset="utf-8">
<title>Mission Control map</title>
<style>
  html, body { margin: 0; height: 100%; background: #0d1117; }
  img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
</style>
<img id="a"><img id="b" style="visibility:hidden">
<script>
  // Load the next frame off-screen, swap only once it has decoded.
  let front = a, back = b;
  function tick() {
    back.onload = () => {
      back.style.visibility = 'visible';
      front.style.visibility = 'hidden';
      [front, back] = [back, front];
      setTimeout(tick, 1000);
    };
    back.onerror = () => setTimeout(tick, 1000);
    back.src = 'map.svg?t=' + Date.now();
  }
  tick();
</script>
EOF
URL="file://$DIR/live.html"
[ -s "$DIR/map.svg" ] || echo "no map yet: run /mission and press c for the Code view"
```

2. If there is no map yet, tell the user to run `/mission`, press `c`, then retry. Stop.

3. If `cmux` is on PATH and `$CMUX_WORKSPACE_ID` is set: `cmux browser open-split "$URL" --focus true`.

4. Otherwise: `open "$URL"`.

The mod only redraws `map.svg` while the Code view is open in `/mission`; if the page looks frozen, press `c` in the pane.

Reply with one line: where it opened and the URL.
