// The code map page: plain HTML and CSS, written to $TMPDIR/mission-control/index.html.
// It draws window.MAP from data.js (see mapData in map.ts). Restyle it here; nothing else
// needs to change. Opened with ?live it re-reads data.js every second (the browser tab);
// without it, it draws once (what headless Chrome screenshots for the terminal pane).
// Keep this free of backticks and dollar-brace sequences: it is one template literal.
export const TEMPLATE = `<!doctype html>
<meta charset="utf-8">
<title>Mission Control: code map</title>
<style>
  :root { --bg:#0d1015; --card:#151922; --card-live:#1b2130; --line:#2a3140; --text:#e8ebf2; --dim:#7d8698; --faint:#4b5263;
          --edge:#3a4252; --edge-hot:#6b7a96; --read:#5aa9ff; --edit:#ffa24c; --changed:#3ddc84; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); overflow: hidden;
    font: 14px -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif; }
  body { display: flex; flex-direction: column; background-image: radial-gradient(#1a1f28 1px, transparent 1px); background-size: 22px 22px; }
  header { display: flex; align-items: center; gap: 8px; padding: 18px 24px 0; flex: none; }
  h1 { margin: 0 12px 0 0; font-size: 20px; }
  .pill { padding: 3px 11px; border: 1px solid var(--line); border-radius: 12px; background: #161b24; font-size: 12.5px; color: var(--dim); }
  .pill.on { color: var(--changed); }
  .now { display: flex; align-items: center; gap: 7px; margin-left: 8px; font-size: 13px; }
  .now i, .dot { width: 9px; height: 9px; border-radius: 50%; background: currentColor; }
  .empty { margin: auto; color: var(--dim); font-size: 16px; }
  #stage { flex: 1; min-height: 0; position: relative; overflow: hidden; }
  #graph { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  #edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .cols { display: flex; gap: 64px; align-items: center; position: relative; }
  .col { display: flex; flex-direction: column; gap: 18px; width: max-content; max-width: 380px; min-width: 170px; }
  .card { position: relative; padding: 10px 16px 12px 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--card);
    box-shadow: 0 4px 12px rgba(0,0,0,.45); }
  .card.live { background: var(--card-live); border-width: 1.5px; }
  .card.read { border-color: var(--read); box-shadow: 0 0 22px rgba(90,169,255,.35); }
  .card.edit { border-color: var(--edit); box-shadow: 0 0 22px rgba(255,162,76,.35); }
  .card.changed::before, .card.read::before, .card.edit::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3.5px; border-radius: 2px; background: var(--accent); }
  .card.read { --accent: var(--read); } .card.edit { --accent: var(--edit); } .card.changed { --accent: var(--changed); }
  .name { display: flex; justify-content: space-between; gap: 12px; font-weight: 650; font-size: 14.5px; white-space: nowrap; }
  .badge { color: var(--accent); font-weight: 400; font-size: 13px; }
  .sub { margin-top: 2px; font: 11px 'SF Mono', Menlo, monospace; color: var(--faint); white-space: nowrap; }
  .why { margin-top: 8px; font-size: 12.5px; line-height: 17px; color: #aeb6c6; overflow-wrap: anywhere; }
  footer { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 24px 16px; }
  footer:empty { display: none; }
  footer b { font-weight: 400; font-size: 11.5px; color: var(--faint); margin-right: 4px; }
  .chip { padding: 3px 11px; border: 1px solid var(--line); border-radius: 12px; background: #141820; font-size: 12px; color: var(--dim); }
</style>
<header id="head"></header>
<div id="stage"><div id="graph"><svg id="edges"></svg><div class="cols" id="cols"></div></div></div>
<footer id="foot"></footer>
<script src="data.js"></script>
<script>
  var SVGNS = 'http://www.w3.org/2000/svg';
  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function render(M) {
    var head = document.getElementById('head'), cols = document.getElementById('cols'), foot = document.getElementById('foot');
    head.textContent = ''; cols.textContent = ''; foot.textContent = '';
    head.appendChild(h('h1', '', 'Code map'));
    head.appendChild(h('span', 'pill', M.files + ' files'));
    head.appendChild(h('span', 'pill' + (M.changed ? ' on' : ''), M.changed + ' changed'));
    if (M.now) {
      var now = h('span', 'now', M.now);
      now.style.color = M.nowState === 'read' ? 'var(--read)' : 'var(--edit)';
      now.insertBefore(h('i'), now.firstChild);
      head.appendChild(now);
    }
    if (!M.files) {
      document.getElementById('graph').style.display = 'none';
      if (!document.querySelector('.empty')) document.getElementById('stage').appendChild(h('div', 'empty', 'Files Claude reads or edits show up here'));
      return;
    }
    document.getElementById('graph').style.display = '';
    var empty = document.querySelector('.empty'); if (empty) empty.remove();

    var cards = {};
    M.columns.forEach(function (col, ci) {
      var colEl = h('div', 'col');
      col.forEach(function (c) {
        var el = h('div', 'card' + (c.live ? ' live' : '') + (c.state ? ' ' + c.state : ''));
        var name = h('div', 'name', c.title);
        var badge = c.live ? (c.state === 'edit' ? '\\u270e' : '\\u25cf') : c.state === 'changed' ? '\\u2713' : '';
        if (badge) name.appendChild(h('span', 'badge', badge));
        el.appendChild(name);
        el.appendChild(h('div', 'sub', c.sub));
        if (c.why) el.appendChild(h('div', 'why', c.why));
        colEl.appendChild(el);
        cards[c.id] = { el: el, col: ci };
      });
      cols.appendChild(colEl);
    });
    M.extra.length && foot.appendChild(h('b', '', 'ALSO READ'));
    M.extra.forEach(function (t) { foot.appendChild(h('span', 'chip', t)); });

    // Measure at 1x, draw the arrows in the graph's own coordinates, then scale the whole graph to fit.
    var graph = document.getElementById('graph'), stage = document.getElementById('stage'), svg = document.getElementById('edges');
    graph.style.transform = '';
    var gw = graph.offsetWidth, gh = graph.offsetHeight;
    svg.setAttribute('width', gw); svg.setAttribute('height', gh);
    svg.textContent = '';
    var defs = document.createElementNS(SVGNS, 'defs');
    defs.innerHTML = '<marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,1L9,5L0,9z" fill="#6b7a96"/></marker>';
    svg.appendChild(defs);
    var gr = graph.getBoundingClientRect();
    function box(id) {
      var r = cards[id].el.getBoundingClientRect();
      return { x: r.left - gr.left, y: r.top - gr.top, w: r.width, h: r.height, col: cards[id].col };
    }
    M.edges.forEach(function (e) {
      if (!cards[e.from] || !cards[e.to]) return;
      var a = box(e.from), b = box(e.to), d;
      var x1 = a.x + a.w, y1 = a.y + Math.min(a.h / 2, 26), x2 = b.x - 4, y2 = b.y + Math.min(b.h / 2, 26);
      if (b.col - a.col > 1) {
        // Skips a column: arc over the cards between, so the arrow is never hidden behind one.
        var peak = a.y < b.y ? a.y : b.y;
        Object.keys(cards).forEach(function (id) {
          var c = box(id);
          if (c.col > a.col && c.col < b.col && c.y < peak) peak = c.y;
        });
        peak -= 34;
        var ax = a.x + a.w * 0.7, bx = b.x + b.w * 0.3;
        d = 'M' + ax + ',' + a.y + ' C' + ax + ',' + peak + ' ' + bx + ',' + peak + ' ' + bx + ',' + (b.y - 4);
      } else if (x2 > x1 + 8) {
        var mid = x1 + (x2 - x1) / 2;
        d = 'M' + x1 + ',' + y1 + ' C' + mid + ',' + y1 + ' ' + mid + ',' + y2 + ' ' + x2 + ',' + y2;
      } else {
        var ay = a.y + a.h, ac = a.x + a.w / 2, bc = b.x + b.w / 2;
        d = 'M' + ac + ',' + ay + ' C' + ac + ',' + (ay + 30) + ' ' + bc + ',' + (b.y - 30) + ' ' + bc + ',' + (b.y - 4);
      }
      var p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', d); p.setAttribute('fill', 'none');
      p.setAttribute('stroke', e.hot ? '#6b7a96' : '#3a4252'); p.setAttribute('stroke-width', e.hot ? 2 : 1.5);
      p.setAttribute('marker-end', 'url(#a)');
      svg.appendChild(p);
    });
    var pad = 24, s = Math.min(1.5, (stage.clientWidth - 2 * pad) / gw, (stage.clientHeight - 2 * pad) / gh);
    graph.style.transform = 'translate(' + (stage.clientWidth - gw * s) / 2 + 'px,' + (stage.clientHeight - gh * s) / 2 + 'px) scale(' + s + ')';
  }

  var last = JSON.stringify(window.MAP);
  render(window.MAP);
  if (location.search.indexOf('live') >= 0) {
    window.addEventListener('resize', function () { render(window.MAP); });
    setInterval(function () {
      var s = document.createElement('script');
      s.src = 'data.js?t=' + Date.now();
      s.onload = function () {
        var now = JSON.stringify(window.MAP);
        if (now !== last) { last = now; render(window.MAP); }
        s.remove();
      };
      s.onerror = function () { s.remove(); };
      document.head.appendChild(s);
    }, 1000);
  }
</script>
`
