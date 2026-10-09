// The Mission Control page: plain HTML and CSS, written to $TMPDIR/mission-control/index.html.
// Two tabs, who (the agent and tool-call tree) and code (the file map), both drawn from
// window.MAP in data.js (see writePage in register.tsx), which it re-reads every second.
// Restyle it here; nothing else needs to change. The tab lives in the URL hash (#who, #code).
// Clicking a changed box on the code map slides a diff drawer up from the bottom (diffs.js, see writePage):
// pick lines, comment, and send the review to Claude (when the mod serves the page) or copy it to paste anywhere.
// Keep this free of backticks, dollar-brace sequences and backslashes: it is one template literal.
import { formatComment, formatReview, parseDiff } from './diff'
import { highlight } from './highlight'
import { htmlRows, langOf } from './hl'

export const TEMPLATE = `<!doctype html>
<meta charset="utf-8">
<title>Mission Control</title>
<style>
  :root { --bg:#0d1015; --card:#151922; --card-live:#1b2130; --line:#2a3140; --text:#e8ebf2; --dim:#7d8698; --faint:#4b5263;
          --edge:#3a4252; --edge-hot:#6b7a96; --read:#5aa9ff; --edit:#ffa24c; --changed:#3ddc84; --flag:#ff5fa8; --stale:#ffbe3c; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); overflow: hidden;
    font: 14px -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif; }
  body { display: flex; flex-direction: column; background-image: radial-gradient(#1a1f28 1px, transparent 1px); background-size: 22px 22px; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 18px 24px 0; flex: none; }
  h1, .pill, .tab, .now, .hint { white-space: nowrap; }
  h1 { margin: 0 12px 0 0; font-size: 20px; }
  .tabs { display: flex; gap: 6px; margin-right: 12px; }
  .tab { padding: 4px 14px; border: 1px solid var(--line); border-radius: 8px; background: #161b24; color: var(--dim); font: inherit; font-size: 13px; cursor: pointer; }
  .tab.on { background: #26324a; color: var(--text); border-color: #3a4a6a; }
  #who { flex: 1; min-height: 0; overflow: auto; padding: 18px 24px; font: 13.5px 'SF Mono', Menlo, monospace; line-height: 22px; }
  .line { white-space: pre; }
  .line .p { color: var(--faint); }
  .line.running { color: #e8c547; } .line.failed { color: #ff6b6b; } .line.done.tool { color: var(--dim); } .line.done.main, .line.done.agent { color: var(--changed); font-weight: 600; }
  .none { color: var(--dim); font: 14px -apple-system, sans-serif; }
  .pill { padding: 3px 11px; border: 1px solid var(--line); border-radius: 12px; background: #161b24; font-size: 12.5px; color: var(--dim); }
  .pill.on { color: var(--changed); }
  a.pill { color: #7fc4ff; text-decoration: none; }
  a.pill:hover { background: #1c2433; }
  .now { display: flex; align-items: center; gap: 7px; margin-left: 8px; font-size: 13px; }
  .now i, .dot { width: 9px; height: 9px; border-radius: 50%; background: currentColor; }
  .empty { margin: auto; color: var(--dim); font-size: 16px; }
  #stage { flex: 1; min-height: 0; position: relative; overflow: hidden; cursor: grab; touch-action: none; user-select: none; }
  #stage.drag { cursor: grabbing; }
  .hint { margin-left: auto; font-size: 11.5px; color: var(--faint); }
  #graph { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  #legend { position: absolute; left: 14px; bottom: 12px; display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--faint); pointer-events: none; }
  #edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .cols { display: flex; gap: 48px; align-items: flex-start; position: relative; }
  .fcols { display: flex; gap: 64px; align-items: center; }
  .frame { padding: 12px 20px 20px; border: 1.5px dashed var(--line); border-radius: 18px; background: rgba(255,255,255,.02); }
  .frame.bare { padding: 0; border: 0; background: none; }
  .frame-title { margin-bottom: 14px; font-size: 11.5px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); white-space: nowrap; }
  .col { display: flex; flex-direction: column; gap: 18px; width: max-content; max-width: 380px; min-width: 170px; }
  .card { position: relative; padding: 10px 16px 12px 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--card);
    box-shadow: 0 4px 12px rgba(0,0,0,.45); }
  .card { cursor: move; }
  .card.moving { z-index: 5; box-shadow: 0 10px 26px rgba(0,0,0,.6); }
  .card.live { background: var(--card-live); border-width: 1.5px; }
  .card.read { border-color: var(--read); box-shadow: 0 0 22px rgba(90,169,255,.35); }
  .card.edit { border-color: var(--edit); box-shadow: 0 0 22px rgba(255,162,76,.35); }
  .card.changed::before, .card.read::before, .card.edit::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3.5px; border-radius: 2px; background: var(--accent); }
  .card.read { --accent: var(--read); } .card.edit { --accent: var(--edit); } .card.changed { --accent: var(--changed); }
  .card.flagged { border-color: var(--flag); box-shadow: 0 0 22px rgba(255,95,168,.35); background: #20141d; --accent: var(--flag); }
  .card.flagged::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3.5px; border-radius: 2px; background: var(--flag); }
  .card.flagged.stale { border-color: var(--stale); box-shadow: 0 0 22px rgba(255,190,60,.25); background: #211b10; --accent: var(--stale); }
  .card.flagged.stale::before { background: var(--stale); }
  .tab:disabled { opacity: .4; cursor: not-allowed; }
  .tab.export { margin-left: auto; }
  .badge.flag { color: var(--flag); font-weight: 650; margin-left: 8px; }
  .badge.flag.stale { color: var(--stale); }
  .pill.flag { color: var(--flag); border-color: var(--flag); }
  .name { display: flex; justify-content: space-between; gap: 12px; font-weight: 650; font-size: 14.5px; white-space: nowrap; }
  .badge { color: var(--accent); font-weight: 400; font-size: 13px; }
  .sub { margin-top: 2px; font: 11px 'SF Mono', Menlo, monospace; color: var(--faint); white-space: nowrap; }
  .why { margin-top: 8px; font-size: 12.5px; line-height: 17px; color: #aeb6c6; overflow-wrap: anywhere; }
  footer { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 24px 16px; }
  footer:empty { display: none; }
  footer b { font-weight: 400; font-size: 11.5px; color: var(--faint); margin-right: 4px; }
  .chip { padding: 3px 11px; border: 1px solid var(--line); border-radius: 12px; background: #141820; font-size: 12px; color: var(--dim); }
  .card.diffable:hover { border-color: #6b7a96; }
  .reset { position: absolute; top: -11px; right: -11px; width: 26px; height: 26px; padding: 0; border: 1px solid #3a4a6a; border-radius: 50%; background: #26324a; color: var(--text); font-size: 15px; line-height: 1; cursor: pointer; opacity: .85; }
  .reset:hover { opacity: 1; background: #3a4a6a; }
  .card.open { outline: 2px solid #5aa9ff; outline-offset: 2px; }
  .card.focus { border-color: var(--changed); box-shadow: 0 0 26px rgba(61,220,132,.55); }
  .tab.go { background: #1d5fd1; border-color: #3b82f6; color: #fff; }
  #drawer { flex: none; height: 45vh; display: flex; flex-direction: column; border-top: 1px solid #3a4a6a; background: #10141b;
    box-shadow: 0 -12px 32px rgba(0,0,0,.55); animation: rise .18s ease-out; }
  #drawer[hidden] { display: none; }
  @keyframes rise { from { transform: translateY(48px); opacity: 0; } }
  .dhead { flex: none; display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
  .dhead b { font-size: 14px; white-space: nowrap; }
  .dsub { font: 11.5px 'SF Mono', Menlo, monospace; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dcopy { margin-left: auto; padding: 2px 6px; border: 1px solid transparent; border-radius: 6px; background: none; font-size: 15px; line-height: 1; cursor: pointer; }
  .dcopy:hover { background: #1c2433; border-color: var(--line); }
  .dclose { border: 0; background: none; color: var(--dim); font-size: 20px; line-height: 1; cursor: pointer; }
  .dbody { flex: 1; min-height: 0; overflow: auto; padding-bottom: 12px; }
  .dbody .none { padding: 18px 16px; }
  .row { display: flex; width: max-content; min-width: 100%; font: 12.5px/19px 'SF Mono', Menlo, monospace; white-space: pre; }
  .row.k-a { background: rgba(61,220,132,.12); } .row.k-d { background: rgba(255,107,107,.12); }
  .row.hunk { color: var(--dim); background: #151b27; padding: 2px 16px; }
  .row.sel { background: rgba(90,169,255,.25); }
  .ln { flex: none; width: 50px; padding-right: 10px; text-align: right; color: var(--faint); cursor: pointer; user-select: none; }
  .ln:hover { color: #fff; background: rgba(255,255,255,.08); }
  .mark { flex: none; width: 18px; color: var(--dim); user-select: none; }
  .code { flex: 1; padding-right: 24px; }
  .hljs-keyword, .hljs-doctag, .hljs-template-tag, .hljs-selector-tag { color: #c792ea; }
  .hljs-string, .hljs-regexp, .hljs-addition, .hljs-meta .hljs-string { color: #a5d6a7; }
  .hljs-comment, .hljs-quote { color: #6b7a96; font-style: italic; }
  .hljs-number, .hljs-literal, .hljs-symbol, .hljs-bullet { color: #f2a65a; }
  .hljs-title, .hljs-title.function_, .hljs-section { color: #82aaff; }
  .hljs-title.class_, .hljs-type, .hljs-built_in, .hljs-name, .hljs-tag { color: #7fc4ff; }
  .hljs-attr, .hljs-attribute, .hljs-property, .hljs-variable, .hljs-template-variable, .hljs-selector-class, .hljs-selector-id { color: #e8c547; }
  .hljs-params, .hljs-subst { color: var(--text); }
  .hljs-meta, .hljs-link, .hljs-deletion { color: #ff8f8f; }
  .hljs-emphasis { font-style: italic; } .hljs-strong { font-weight: 700; }
  .t-kw { color: #c792ea; } .t-str { color: #a5d6a7; } .t-com { color: #6b7a96; font-style: italic; } .t-num { color: #f2a65a; } .t-type { color: #7fc4ff; }
  .note, .editor { margin: 6px 16px 8px 68px; padding: 8px 12px; border: 1px solid #3a4a6a; border-radius: 8px; background: #171d29; font: 13px -apple-system, sans-serif; width: min(640px, calc(100% - 100px)); }
  .note { display: flex; gap: 10px; align-items: flex-start; white-space: pre-wrap; }
  .note span { flex: 1; overflow-wrap: anywhere; }
  .note.sent { opacity: .6; }
  .finding { display: flex; gap: 10px; align-items: flex-start; margin: 6px 16px 8px 68px; padding: 8px 12px; border: 1px solid var(--flag); border-radius: 8px; background: #26121d; font: 13px -apple-system, sans-serif; width: min(640px, calc(100% - 100px)); white-space: normal; }
  .finding input.fsw { margin-top: 0; }
  .finding .fbody { flex: 1; overflow-wrap: anywhere; } .finding b { color: #ffb3d6; }
  .finding .fsc { margin-top: 4px; color: #c9a3b6; line-height: 18px; }
  .finding.posted { opacity: .55; }
  .finding.seen { box-shadow: 0 0 0 2px var(--flag), 0 0 18px rgba(255,95,168,.5); }
  .finding.stale { border-color: var(--stale); background: #211b10; } .finding.stale b { color: #ffd98a; }
  .finding .fdis, #flist .fl-dis { flex: none; border: 0; background: none; color: var(--dim); cursor: pointer; font-size: 12px; }
  .finding .fdis:hover, #flist .fl-dis:hover { color: var(--text); }
  #flist label.stale .fl-line { color: var(--stale); }
  #flist { position: fixed; right: 16px; top: 64px; width: 400px; max-width: calc(100% - 32px); max-height: 60vh; overflow: auto; z-index: 8; border: 1px solid var(--flag); border-radius: 10px; background: #1a0f17; box-shadow: 0 12px 32px rgba(0,0,0,.55); font: 13px -apple-system, sans-serif; }
  #flist[hidden] { display: none; }
  #flist .fl-head { position: sticky; top: 0; display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #1a0f17; border-bottom: 1px solid #4a2438; }
  #flist .fl-head b { flex: 1; color: #ffb3d6; }
  #flist .fl-file { padding: 8px 12px 2px; font: 11.5px 'SF Mono', Menlo, monospace; color: var(--dim); }
  #flist label { display: flex; gap: 8px; align-items: flex-start; padding: 5px 12px; cursor: pointer; line-height: 18px; }
  #flist label:hover { background: #26121d; }
  #flist label.posted { opacity: .5; cursor: default; }
  #flist .fl-line { flex: none; color: var(--flag); font: 11.5px 'SF Mono', Menlo, monospace; min-width: 34px; }
  #flist .fl-open { border: 0; background: none; color: var(--dim); cursor: pointer; font-size: 12px; }
  .pill.flag { cursor: pointer; }
  input.fsw { appearance: none; -webkit-appearance: none; flex: none; position: relative; width: 40px; height: 22px; margin: 0; border-radius: 11px; background: #3a2a34; border: 1px solid #5a3a4c; cursor: pointer; transition: background .15s; }
  input.fsw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #c9a3b6; transition: transform .15s, background .15s; }
  input.fsw:checked { background: var(--flag); border-color: var(--flag); }
  input.fsw:checked::after { transform: translateX(18px); background: #fff; }
  input.fsw:disabled { opacity: .4; cursor: default; }
  .finding { cursor: pointer; } .finding.posted { cursor: default; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; }
  .segb { padding: 5px 14px; border: 0; background: #151b27; color: var(--dim); font-size: 13px; cursor: pointer; }
  .segb.on { background: var(--flag); color: #fff; font-weight: 650; }
  .segb:disabled { opacity: .4; cursor: default; }
  .swall { display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; background: #151b27; color: var(--text); font-size: 13px; cursor: pointer; user-select: none; }
  .swall:hover { border-color: var(--flag); }
  .note button { border: 0; background: none; color: var(--faint); cursor: pointer; }
  .editor textarea { display: block; width: 100%; min-height: 58px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: #0d1015; color: var(--text); font: 13px -apple-system, sans-serif; resize: vertical; }
  .editor .btns { display: flex; gap: 8px; margin-top: 8px; }
  .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); padding: 8px 16px; border-radius: 10px; background: #26324a; border: 1px solid #3a4a6a; font-size: 13px; z-index: 9; }
</style>
<header id="head"></header>
<div id="who" hidden></div>
<div id="stage"><div id="graph"><svg id="edges"></svg><div class="cols" id="cols"></div></div><div id="legend"><svg width="30" height="8"><line x1="1" y1="4" x2="22" y2="4" stroke="#6b7a96" stroke-width="1.5"/><path d="M21,0.5L29,4L21,7.5z" fill="#6b7a96"/></svg>A → B: B uses A (a change in A reaches B)</div></div>
<footer id="foot"></footer>
<div id="drawer" hidden></div>
<div id="flist" hidden></div>
<script src="hljs.js"></script>
<script src="data.js"></script>
<script>
  // Shared with the tests: the code in hooks/diff.ts, spliced in as it is.
  ${parseDiff}
  ${formatComment}
  ${formatReview}
  ${highlight}
  ${langOf}
  ${htmlRows}
  // The code map's view: fitted to the window until the person zooms or drags, then kept as they left it.
  var view = { k: 1, x: 0, y: 0, auto: true };
  function applyView() {
    document.getElementById('graph').style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
  }
  // Where the person dragged each box (offsets from its laid-out place), kept per page and across reloads.
  var POSKEY = 'mission-pos:' + location.pathname, pos = {}, dragging = false, stale = false, model = { cards: {}, edges: [] };
  try { pos = JSON.parse(localStorage.getItem(POSKEY) || '{}') || {}; } catch (err) { pos = {}; }
  function savePos() { try { localStorage.setItem(POSKEY, JSON.stringify(pos)); } catch (err) {} }
  function place(el, id) {
    var p = pos[id];
    el.style.transform = p ? 'translate(' + p.dx + 'px,' + p.dy + 'px)' : '';
  }
  // A box that has been moved carries a small button to put it back.
  function putBack(el, id) {
    var old = el.querySelector('.reset');
    if (!pos[id]) { if (old) old.remove(); return; }
    if (old) return;
    var b = h('button', 'reset', '\u21ba');
    b.title = 'Put this box back';
    b.onpointerdown = function (e) { e.stopPropagation(); };
    b.ondblclick = function (e) { e.stopPropagation(); };
    b.onclick = function (e) {
      e.stopPropagation();
      delete pos[id]; savePos(); place(el, id); putBack(el, id); drawEdges();
    };
    el.appendChild(b);
  }
  var focusId = null; // the box whose links are the only ones drawn, set by double-clicking it
  function setFocus(id) {
    focusId = id;
    render(window.MAP);
  }
  var clickTimer = null; // a click on a changed box waits to see whether it is the first half of a double-click
  // The tab in the hash, else the one used last on this page.
  var TABKEY = 'mission-tab:' + location.pathname;
  function tab() {
    if (location.hash === '#code' || location.hash === '#who') return location.hash.slice(1);
    try { return localStorage.getItem(TABKEY) === 'code' ? 'code' : 'who'; } catch (err) { return 'who'; }
  }
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
    head.appendChild(h('h1', '', 'Mission Control'));
    var tabs = h('div', 'tabs');
    [['who', 'Who (w)'], ['code', 'Code (c)']].forEach(function (t) {
      var b = h('button', 'tab' + (tab() === t[0] ? ' on' : ''), t[1]);
      b.onclick = function () { location.hash = t[0]; render(window.MAP); };
      tabs.appendChild(b);
    });
    head.appendChild(tabs);
    if (M.where) {
      head.appendChild(h('span', 'pill', '\u2387 ' + M.where.branch + (M.where.base ? ' \u2192 ' + M.where.base : '')));
      if (M.where.pr && M.where.pr.url.indexOf('https://') === 0) {
        var pl = h('a', 'pill', 'PR #' + M.where.pr.number + ' \u2197');
        pl.href = M.where.pr.url; pl.target = '_blank'; pl.rel = 'noopener'; pl.title = M.where.pr.url;
        head.appendChild(pl);
      }
    }
    var S = M.who.summary;
    head.appendChild(h('span', 'pill', S.agents + ' agents (' + S.running + ' running) \u00b7 ' + S.tools + ' tool calls' + (S.failed ? ' \u00b7 ' + S.failed + ' failed' : '')));
    head.appendChild(h('span', 'pill', M.files + ' files'));
    head.appendChild(h('span', 'pill' + (M.changed ? ' on' : ''), M.changed + ' changed'));
    var FL = M.findings || {}, fAll = [];
    Object.keys(FL).forEach(function (p) { FL[p].forEach(function (f) { fAll.push(f); }); });
    if (fAll.length) {
      var fp = h('span', 'pill flag', '\\u2691 ' + fAll.length + ' finding' + (fAll.length === 1 ? '' : 's') + (showList ? ' \\u25b4' : ' \\u25be'));
      fp.title = 'Show every finding, to pick them one by one';
      fp.onclick = function () { showList = !showList; render(window.MAP); };
      head.appendChild(fp);
    }
    var openF = fAll.filter(function (f) { return !f.posted; });
    if (openF.length) {
      var npicked = Object.keys(fpick).length;
      var all = h('label', 'swall'), sw = document.createElement('input');
      sw.type = 'checkbox'; sw.className = 'fsw'; sw.checked = npicked === openF.length;
      sw.onchange = function () { fpick = {}; if (sw.checked) openF.forEach(function (f) { fpick[f.id] = true; }); render(window.MAP); renderDrawer(); };
      all.appendChild(sw);
      all.appendChild(h('span', '', npicked && npicked < openF.length ? npicked + ' of ' + openF.length + ' picked' : 'All findings (' + openF.length + ')'));
      all.title = 'Pick or drop every finding that is not pushed yet; switch them one by one in the list or under their line';
      head.appendChild(all);
    }
    if (Object.keys(fpick).length) {
      var nPick = Object.keys(fpick).length, toPr = canPost() && dest !== 'claude';
      // Where the picked findings go: the pull request (when the page is about one) or the Claude session.
      var seg = h('span', 'seg');
      [['pr', 'PR'], ['claude', 'Claude']].forEach(function (d) {
        var on = (d[0] === 'pr') === toPr, b = h('button', 'segb' + (on ? ' on' : ''), d[1]);
        if (d[0] === 'pr' && !canPost()) { b.disabled = true; b.title = 'Needs the local server and a page about a pull request (/mission <PR link>)'; }
        b.onclick = function () { dest = d[0]; render(window.MAP); };
        seg.appendChild(b);
      });
      head.appendChild(seg);
      if (EXPORTED) head.appendChild(modOnly(h('button', 'tab go', 'Send to Claude (' + nPick + ')')));
      var go = h('button', 'tab go', toPr ? 'Send to PR (' + nPick + ')' : (CAN_SEND ? 'Send to Claude (' : 'Copy for Claude (') + nPick + ')');
      go.title = toPr ? 'Push the picked findings to the pull request as one review of comments' : 'Hand the picked findings to the Claude session as a request to fix them';
      go.onclick = toPr ? postPicked : sendPicked;
      head.appendChild(go);
    }
    if (M.post && M.post.note) head.appendChild(h('span', 'pill', M.post.note));
    renderList(M);
    if (pending.length) {
      var fresh = pending.filter(function (c) { return !c.sent; }).length;
      if (fresh && EXPORTED) {
        head.appendChild(modOnly(h('button', 'tab go', 'Send review (' + fresh + ')')));
      } else if (fresh) {
        var send = h('button', 'tab go', 'Send review (' + fresh + ')');
        send.onclick = sendReview;
        head.appendChild(send);
      }
      if (CAN_SEND || EXPORTED || fresh < pending.length) {
        var all = h('button', 'tab', (CAN_SEND || EXPORTED ? 'Copy (' : fresh ? 'Copy all (' : 'Copy again (') + pending.length + ')');
        all.title = 'Copy every comment on the page, the ones already copied too';
        all.onclick = function () { copyAll(); };
        head.appendChild(all);
      }
      var drop = h('button', 'tab', 'Discard');
      drop.onclick = function () { pending = []; savePending(); render(window.MAP); renderDrawer(); };
      head.appendChild(drop);
    }
    if (focusId && !M.groups.some(function (g) { return g.columns.some(function (col) { return col.some(function (c) { return c.id === focusId; }); }); })) focusId = null;
    if (focusId && tab() === 'code') {
      var xf = h('button', 'tab go', 'Exit focus (Esc)');
      xf.title = 'Show every link again';
      xf.onclick = function () { setFocus(null); };
      head.appendChild(xf);
    }
    if (tab() === 'code') head.appendChild(h('span', 'hint', 'scroll zooms \u00b7 drag the map or a box \u00b7 click a changed box for its diff \u00b7 double-click a box: focus its links \u00b7 double-click the map: fit \u00b7 \u21ba puts a box back'));
    if (M.now) {
      var now = h('span', 'now', M.now);
      now.style.color = M.nowState === 'read' ? 'var(--read)' : 'var(--edit)';
      now.insertBefore(h('i'), now.firstChild);
      head.appendChild(now);
    }
    if (EXPORTED) {
      var snap = h('span', 'pill export', 'snapshot · ' + new Date(window.EXPORTED).toLocaleString());
      snap.style.marginLeft = 'auto'; snap.title = 'Exported from Mission Control: it does not update';
      head.appendChild(snap);
    } else {
      var ex = h('button', 'tab export', 'Export HTML');
      if (CAN_SEND) { ex.title = 'Download this page, findings and diffs included, as one HTML file'; ex.onclick = exportPage; } else { ex.disabled = true; ex.title = 'Needs the page served by the mod'; }
      head.appendChild(ex);
    }
    try { localStorage.setItem(TABKEY, tab()); } catch (err) {}
    var whoEl = document.getElementById('who'), stageEl = document.getElementById('stage');
    whoEl.hidden = tab() !== 'who'; stageEl.hidden = tab() !== 'code'; foot.hidden = tab() !== 'code';
    document.getElementById('drawer').hidden = !openPath || tab() !== 'code';
    if (tab() === 'who') {
      whoEl.textContent = '';
      if (!M.who.lines.length) whoEl.appendChild(h('div', 'none', 'Nothing yet. Start a task and watch it fill in.'));
      M.who.lines.forEach(function (l) {
        var row = h('div', 'line ' + l.status + ' ' + l.kind);
        row.appendChild(h('span', 'p', l.prefix));
        row.appendChild(document.createTextNode(l.text));
        whoEl.appendChild(row);
      });
      return;
    }
    if (!M.files) {
      document.getElementById('graph').style.display = 'none';
      if (!document.querySelector('.empty')) document.getElementById('stage').appendChild(h('div', 'empty', 'Files Claude reads or edits show up here'));
      return;
    }
    document.getElementById('graph').style.display = '';
    var empty = document.querySelector('.empty'); if (empty) empty.remove();

    // One frame per kind of file (tests, translations, config...), named when there is more than one kind.
    var cards = {}, ci = 0, framed = M.groups.length > 1;
    M.groups.forEach(function (g) {
      var frame = h('div', 'frame' + (framed ? '' : ' bare')), inner = h('div', 'fcols'), n = 0;
      g.columns.forEach(function (col) {
        var colEl = h('div', 'col');
        col.forEach(function (c) {
          var el = h('div', 'card' + (c.live ? ' live' : '') + (c.state ? ' ' + c.state : '') + (c.flags ? ' flagged' : '') + (c.flags && c.stale ? ' stale' : '') + (hasDiff(M, c.id) ? ' diffable' : '') + (openPath === c.id ? ' open' : '') + (focusId === c.id ? ' focus' : ''));
          if (hasDiff(M, c.id)) el.title = 'Click for the diff';
          var name = h('div', 'name', c.title);
          var badge = c.live ? (c.state === 'edit' ? '\\u270e' : '\\u25cf') : c.state === 'changed' ? '\\u2713' : '';
          if (badge) name.appendChild(h('span', 'badge', badge));
          if (c.flags) { var fb = h('span', 'badge flag' + (c.stale ? ' stale' : ''), '\\u2691 ' + c.flags); fb.title = c.flags + ' review finding' + (c.flags === 1 ? '' : 's') + ' on this file' + (c.stale ? ', written before the file was last edited' : ''); name.appendChild(fb); }
          el.appendChild(name);
          el.appendChild(h('div', 'sub', c.sub));
          if (c.why) el.appendChild(h('div', 'why', c.why));
          colEl.appendChild(el);
          cards[c.id] = { el: el, col: ci };
          n++;
          place(el, c.id);
          putBack(el, c.id);
          grab(el, c.id, hasDiff(M, c.id));
        });
        inner.appendChild(colEl);
        ci++;
      });
      if (framed) frame.appendChild(h('div', 'frame-title', g.name + ' · ' + n));
      frame.appendChild(inner);
      cols.appendChild(frame);
    });
    M.extra.length && foot.appendChild(h('b', '', 'ALSO READ'));
    M.extra.forEach(function (t) { foot.appendChild(h('span', 'chip', t)); });

    // Measure at 1x, draw the arrows in the graph's own coordinates, then scale the whole graph to fit.
    var graph = document.getElementById('graph'), stage = document.getElementById('stage');
    graph.style.transform = '';
    var gw = graph.offsetWidth, gh = graph.offsetHeight;
    model = { cards: cards, edges: M.edges };
    drawEdges();
    var pad = 24, s = Math.min(1.5, (stage.clientWidth - 2 * pad) / gw, (stage.clientHeight - 2 * pad) / gh);
    if (view.auto) view = { k: s, x: (stage.clientWidth - gw * s) / 2, y: (stage.clientHeight - gh * s) / 2, auto: true };
    applyView();
  }

  // The arrows, from where the boxes are now. Works at any zoom: positions are divided by the graph's scale.
  function drawEdges() {
    var graph = document.getElementById('graph'), svg = document.getElementById('edges');
    var cards = model.cards, gw = graph.offsetWidth, gh = graph.offsetHeight;
    svg.setAttribute('width', gw); svg.setAttribute('height', gh);
    svg.textContent = '';
    var defs = document.createElementNS(SVGNS, 'defs');
    defs.innerHTML = '<marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,1L9,5L0,9z" fill="#6b7a96"/></marker>';
    svg.appendChild(defs);
    var gr = graph.getBoundingClientRect(), k = gr.width / (gw || 1) || 1;
    function box(id) {
      var r = cards[id].el.getBoundingClientRect();
      return { x: (r.left - gr.left) / k, y: (r.top - gr.top) / k, w: r.width / k, h: r.height / k, col: cards[id].col };
    }
    model.edges.forEach(function (e) {
      if (!cards[e.from] || !cards[e.to]) return;
      if (focusId && e.from !== focusId && e.to !== focusId) return;
      var a = box(e.from), b = box(e.to), d;
      var x1 = a.x + a.w, y1 = a.y + Math.min(a.h / 2, 26), x2 = b.x - 4, y2 = b.y + Math.min(b.h / 2, 26);
      if (b.col - a.col > 1 && x2 > x1 + 8 && !pos[e.from] && !pos[e.to]) {
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
  }

  // Drag a box to move it, so tangled arrows can be pulled apart; double-click it to put it back.
  function grab(el, id, diffable) {
    el.addEventListener('pointerdown', function (e) {
      e.stopPropagation(); // not the map's own drag
      var from = { x: e.clientX, y: e.clientY }, base = pos[id] || { dx: 0, dy: 0 }, moved = false;
      dragging = true;
      el.classList.add('moving');
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      function move(ev) {
        if (Math.abs(ev.clientX - from.x) + Math.abs(ev.clientY - from.y) > 4) moved = true;
        pos[id] = { dx: base.dx + (ev.clientX - from.x) / view.k, dy: base.dy + (ev.clientY - from.y) / view.k };
        place(el, id);
        drawEdges();
      }
      function end(ev) {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
        el.classList.remove('moving');
        dragging = false;
        savePos();
        if (moved) putBack(el, id);
        if (diffable && !moved && ev.type === 'pointerup') {
          if (clickTimer) clearTimeout(clickTimer);
          clickTimer = setTimeout(function () { clickTimer = null; toggleDrawer(id); }, 250);
          return;
        }
        if (stale) { stale = false; render(window.MAP); }
      }
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    });
    el.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; } // a double-click is not a click
      setFocus(focusId === id ? null : id);
    });
  }

  // Scroll or pinch to zoom around the pointer, drag to move, double-click (or 0) to fit again.
  (function () {
    var stage = document.getElementById('stage'), drag = null;
    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = stage.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      var k = Math.min(6, Math.max(0.15, view.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))));
      view = { k: k, x: px - (px - view.x) * (k / view.k), y: py - (py - view.y) * (k / view.k), auto: false };
      applyView();
    }, { passive: false });
    stage.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('drag');
    });
    stage.addEventListener('pointermove', function (e) {
      if (!drag) return;
      view = { k: view.k, x: view.x + e.clientX - drag.x, y: view.y + e.clientY - drag.y, auto: false };
      drag = { x: e.clientX, y: e.clientY, sx: drag.sx, sy: drag.sy };
      applyView();
    });
    function end(e) {
      // A click on the bare map, not a drag, puts the drawer away.
      var click = drag && e.type === 'pointerup' && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 4;
      drag = null; stage.classList.remove('drag');
      if (click && openPath) closeDrawer();
    }
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('dblclick', function () { view.auto = true; render(window.MAP); });
  })();


  // The diff drawer: the open file, the rows picked to comment on, the comment being written, and the review so far.
  var openPath = null, sel = null, draftText = '', EXPORTED = !!window.EXPORTED, CAN_SEND = !EXPORTED && location.protocol === 'http:', REVKEY = 'mission-review:' + (CAN_SEND ? 'http' : location.pathname), pending = [], DIFFREV = null;
  try { pending = JSON.parse(localStorage.getItem(REVKEY) || '[]') || []; } catch (err) { pending = []; }
  function savePending() { try { localStorage.setItem(REVKEY, JSON.stringify(pending)); } catch (err) {} }
  function hasDiff(M, id) { return !!(M.diffs && M.diffs.paths.indexOf(id) >= 0); }
  function toggleDrawer(id) {
    openPath = openPath === id ? null : id;
    sel = null; draftText = '';
    renderDrawer();
    render(window.MAP); // the map makes room, or takes it back
  }
  function closeDrawer() { if (openPath) toggleDrawer(openPath); }
  function toast(text) {
    var t = h('div', 'toast', text);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }
  // To the clipboard; where the browser refuses (a file page may), a box the person can copy from.
  function copyText(text, done) {
    function fallback() {
      var ta = document.createElement('textarea'), ok = false;
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (err) {}
      ta.remove();
      if (!ok) window.prompt('Copy this review, then paste it into Claude:', text);
      done();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  function refOf(list) {
    var r = list.length ? list[0].ref : '';
    return list.every(function (c) { return c.ref === r; }) ? r : '';
  }
  // Copying keeps the comments, marked as sent, so a paste that goes wrong costs nothing. They go when Claude
  // changes their file again (sweep); a comment not copied yet is never dropped, only marked outdated.
  // To Claude's session when the page is served by the mod (CAN_SEND), else, or where that fails, to the clipboard.
  function deliver(text, done) {
    function copy() { copyText(text, function () { done(false); }); }
    if (!CAN_SEND) return copy();
    fetch('send', { method: 'POST', body: JSON.stringify({ text: text }) }).then(function (r) { if (r.ok) done(true); else copy(); }, copy);
  }
  function said(n, sent) {
    var what = n + ' comment' + (n === 1 ? '' : 's');
    return sent ? 'Sent ' + what + ' to Claude.' : 'Copied ' + what + '. Paste ' + (n === 1 ? 'it' : 'them') + ' into Claude.';
  }
  function ship(list, send) {
    (send ? deliver : function (text, done) { copyText(text, function () { done(false); }); })(formatReview(list, refOf(list)), function (sent) {
      list.forEach(function (c) { c.sent = true; });
      savePending();
      toast(said(list.length, sent));
      render(window.MAP); renderDrawer();
    });
  }
  function sendReview() { ship(pending.filter(function (c) { return !c.sent; }), true); }
  function copyAll() { ship(pending.slice(), false); }
  // A fingerprint of a file's diff: it changes when the file does.
  function fpOf(text) {
    var x = 7;
    for (var i = 0; i < text.length; i++) x = (Math.imul(x, 31) + text.charCodeAt(i)) | 0;
    return x;
  }
  function changedSince(c) {
    var d = diffOf(c.path);
    return !!(d && c.fp !== undefined && fpOf(d.text) !== c.fp);
  }
  // Claude has worked on a file again: its comments that were already copied have been dealt with.
  function sweep() {
    var kept = pending.filter(function (c) { return !(c.sent && changedSince(c)); });
    if (kept.length === pending.length) return;
    pending = kept; savePending();
    render(window.MAP); renderDrawer();
  }
  function picked() {
    if (!sel) return [];
    var lo = Math.min(sel.a, sel.b), hi = Math.max(sel.a, sel.b);
    return rowsNow.slice(lo, hi + 1).filter(function (r) { return r.k !== 'h'; });
  }
  function draft(send) {
    var text = draftText.trim(), lines = picked();
    if (!text || !lines.length) return;
    var d = diffOf(openPath) || {};
    var c = { id: Date.now() + '-' + Math.random(), path: openPath, ref: d.ref || '', lines: lines, text: text, fp: fpOf(d.text || ''), sent: !!send };
    sel = null; draftText = '';
    pending.push(c); savePending();
    render(window.MAP); renderDrawer();
    if (send) deliver(formatReview([c], c.ref), function (sent) { toast(said(1, sent)); });
  }
  var rowsNow = [], selDrag = false;
  // The rows under the selection, lit as the mouse moves; the comment box comes once the button is let go.
  function paintSel() {
    var lo = Math.min(sel.a, sel.b), hi = Math.max(sel.a, sel.b);
    [].forEach.call(document.querySelectorAll('.dbody .row[data-i]'), function (r) {
      var i = Number(r.getAttribute('data-i'));
      r.classList.toggle('sel', i >= lo && i <= hi);
    });
  }
  window.addEventListener('mouseup', function () { if (selDrag) { selDrag = false; renderDrawer(); } });
  function diffOf(path) { return window.DIFFS && window.DIFFS[path]; }
  // Review findings: the reviewer picks the ones to push to the pull request. Only ids go back; the mod posts what it holds.
  var fpick = {}, showList = false, dest = 'pr', wantF = null; // wantF: the finding the drawer scrolls to once it is drawn
  // Every finding in one panel, one checkbox each, so none needs its file opened to be picked or dropped.
  function renderList(M) {
    var el = document.getElementById('flist'), keep = el.scrollTop, FL = M.findings || {}, paths = Object.keys(FL);
    el.textContent = '';
    el.hidden = !showList || !paths.length || tab() !== 'code';
    if (el.hidden) return;
    var head = h('div', 'fl-head'), n = Object.keys(fpick).length;
    head.appendChild(h('b', '', n ? n + ' picked' : 'Pick findings to post'));
    var x = h('button', 'fl-open', '\\u00d7'); x.title = 'Close the list';
    x.onclick = function () { showList = false; render(window.MAP); };
    head.appendChild(x);
    el.appendChild(head);
    paths.forEach(function (p) {
      var file = h('div', 'fl-file', p.split('/').slice(-2).join('/'));
      file.title = p;
      el.appendChild(file);
      FL[p].forEach(function (f) {
        var row = h('label', (f.posted ? 'posted' : '') + (f.stale && !f.posted ? ' stale' : '')), box = document.createElement('input');
        box.type = 'checkbox'; box.className = 'fsw'; box.checked = !!fpick[f.id]; box.disabled = !!f.posted;
        box.onchange = function () { if (box.checked) fpick[f.id] = true; else delete fpick[f.id]; render(window.MAP); renderDrawer(); };
        row.appendChild(box);
        row.appendChild(h('span', 'fl-line', f.line ? 'L' + f.line : 'file'));
        row.appendChild(h('span', '', (f.posted ? '\\u2713 ' : '') + (f.stale && !f.posted ? '\\u21bb ' : '') + f.summary));
        var go = h('button', 'fl-open', '\\u2197'); go.title = 'Open the diff at this finding';
        go.onclick = function (e) { e.preventDefault(); wantF = f.id; if (openPath !== p) toggleDrawer(p); else renderDrawer(); };
        row.appendChild(go);
        row.appendChild(dismissBtn(f, 'fl-dis'));
        el.appendChild(row);
      });
    });
    el.scrollTop = keep;
  }
  function canPost() { return CAN_SEND && !!(window.MAP && window.MAP.post && window.MAP.post.can); }
  function pickedFindings() {
    var FL = (window.MAP && window.MAP.findings) || {}, out = [];
    Object.keys(FL).forEach(function (p) { FL[p].forEach(function (f) { if (fpick[f.id]) out.push(f); }); });
    return out;
  }
  // The picked findings as a request to Claude; deliver() sends it to the session, or copies it where there is no server.
  function sendPicked() {
    var list = pickedFindings();
    if (!list.length) return;
    var where = window.MAP && window.MAP.where, lines = ['Fix these ' + list.length + ' code review finding' + (list.length === 1 ? '' : 's') + (where && where.branch ? ' (branch ' + where.branch + ')' : '') + '. Check each against the code before changing it, and say if one is wrong:', ''];
    list.forEach(function (f, i) {
      lines.push((i + 1) + '. ' + f.file + (f.line ? ':' + f.line : '') + (f.severity ? ' [' + f.severity + ']' : '') + ' - ' + f.summary);
      if (f.scenario) lines.push('   ' + f.scenario);
    });
    deliver(lines.join('\\n'), function (sent) {
      toast(sent ? 'Sent ' + list.length + ' finding' + (list.length === 1 ? '' : 's') + ' to Claude.' : 'Copied ' + list.length + '. Paste into Claude.');
      fpick = {}; render(window.MAP); renderDrawer();
    });
  }
  function postPicked() {
    var ids = Object.keys(fpick).map(Number);
    if (!ids.length) return;
    if (!confirm('Post ' + ids.length + ' comment' + (ids.length === 1 ? '' : 's') + ' to the pull request as one review?')) return;
    fetch('post', { method: 'POST', body: JSON.stringify({ ids: ids }) }).then(function (r) {
      if (r.ok) { fpick = {}; toast('Posting to the pull request\\u2026'); render(window.MAP); renderDrawer(); } else toast('Could not send the request');
    }, function () { toast('Could not send the request'); });
  }
  // Puts a finding away for good. Only its id goes back; the mod marks it and the page stops drawing it.
  function dismissBtn(f, cls) {
    var b = h('button', cls, '\\u00d7'); b.title = 'Dismiss this finding';
    b.onclick = function (e) {
      e.preventDefault(); e.stopPropagation();
      if (EXPORTED) return dropLocal(f); // no mod to tell: the snapshot just stops showing it
      delete fpick[f.id];
      fetch('dismiss', { method: 'POST', body: JSON.stringify({ ids: [f.id] }) }).then(function (r) {
        if (!r.ok) toast('Could not dismiss');
      }, function () { toast('Could not dismiss: needs the local server'); });
    };
    return b;
  }
  // A button for what only the mod can do: greyed out, and the hover says why.
  function modOnly(b) { b.disabled = true; b.title = 'Only available in the Mission Control mod'; return b; }
  // The exported page has no mod behind it: a dismissed finding is taken out of the page's own data.
  function dropLocal(f) {
    var M = window.MAP, FL = M.findings || {};
    Object.keys(FL).forEach(function (p) {
      var rest = FL[p].filter(function (x) { return x.id !== f.id; });
      if (rest.length === FL[p].length) return;
      if (rest.length) FL[p] = rest; else delete FL[p];
      var open = rest.filter(function (x) { return !x.posted; });
      M.groups.forEach(function (g) { g.columns.forEach(function (col) { col.forEach(function (c) {
        if (c.id === p) { c.flags = open.length || rest.length; c.stale = open.length > 0 && open.every(function (x) { return x.stale; }); }
      }); }); });
    });
    delete fpick[f.id];
    render(M); renderDrawer();
  }
  // The page as one file to keep or send: the template, highlight.js and this page's data and diffs inlined. Opened from
  // disk it is a snapshot (EXPORTED): nothing re-reads data.js, and what needs the mod is greyed out.
  function exportPage() {
    var get = function (n) { return fetch(n, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(n); return r.text(); }); };
    Promise.all([get('index.html'), get('hljs.js')]).then(function (t) {
      var bs = String.fromCharCode(92), json = function (v) { return JSON.stringify(v).replace(new RegExp('<', 'g'), bs + 'u003c'); };
      var data = 'window.MAP = ' + json(window.MAP) + '; window.DIFFS = ' + json(window.DIFFS || {}) + '; window.EXPORTED = ' + Date.now() + ';';
      var hl = t[1].replace(new RegExp('<' + '/script', 'gi'), function () { return '<' + bs + '/script'; });
      var page = t[0], tags = ['<script src="hljs.js"><' + '/script>', '<script src="data.js"><' + '/script>'];
      if (page.indexOf(tags[0]) < 0 || page.indexOf(tags[1]) < 0) throw new Error('page');
      page = page.replace(tags[0], function () { return '<script>' + hl + '<' + '/script>'; }).replace(tags[1], function () { return '<script>' + data + '<' + '/script>'; });
      var where = window.MAP && window.MAP.where, name = 'mission-control-' + ((where && where.branch) || 'review').replace(new RegExp('[^A-Za-z0-9._-]+', 'g'), '-') + '-' + new Date().toISOString().slice(0, 10) + '.html';
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([page], { type: 'text/html' })); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast('Exported ' + name);
    }).catch(function () { toast('Could not export the page'); });
  }
  function findingEl(f) {
    var el = h('div', 'finding' + (f.posted ? ' posted' : '') + (f.stale && !f.posted ? ' stale' : ''));
    el.setAttribute('data-fid', String(f.id));
    var box = document.createElement('input');
    box.type = 'checkbox'; box.className = 'fsw'; box.checked = !!fpick[f.id]; box.disabled = !!f.posted;
    box.title = f.posted ? 'Already on the pull request' : 'Pick to send to Claude' + (canPost() ? ' or post to the pull request' : '');
    box.onchange = function () { if (box.checked) fpick[f.id] = true; else delete fpick[f.id]; render(window.MAP); renderDrawer(); };
    var body = h('div', 'fbody');
    body.appendChild(h('b', '', (f.severity ? f.severity + ' \\u00b7 ' : '') + f.summary));
    if (f.scenario) body.appendChild(h('div', 'fsc', f.scenario));
    if (f.posted) body.appendChild(h('div', 'fsc', '\\u2713 pushed to the pull request'));
    else if (f.stale) body.appendChild(h('div', 'fsc', '\\u21bb edited since this review: the line may have moved, or it may be fixed'));
    el.appendChild(box); el.appendChild(body); el.appendChild(dismissBtn(f, 'fdis'));
    el.onclick = function (e) { if (e.target !== box && !box.disabled) box.click(); }; // the whole card is the target, not just the switch
    return el;
  }
  function sameRow(a, b) { return a.k === b.k && a.o === b.o && a.n === b.n; }
  function renderDrawer() {
    var el = document.getElementById('drawer');
    var keep = el.querySelector('.dbody'), top = keep ? keep.scrollTop : 0;
    el.hidden = !openPath || tab() !== 'code';
    el.textContent = '';
    if (el.hidden) return;
    var head = h('div', 'dhead');
    head.appendChild(h('b', '', openPath.split('/').slice(-2).join('/')));
    var sub = h('span', 'dsub', openPath);
    sub.title = 'Click or drag line numbers to comment, shift-click extends, esc closes';
    head.appendChild(sub);
    var cp = h('button', 'dcopy', '\ud83d\udccb'); cp.title = 'Copy the file path';
    cp.onclick = function () { copyText(openPath, function () { toast('Copied ' + openPath); }); };
    head.appendChild(cp);
    var x = h('button', 'dclose', '\u00d7'); x.title = 'Close';
    x.onclick = closeDrawer;
    head.appendChild(x);
    el.appendChild(head);
    var body = h('div', 'dbody');
    el.appendChild(body);
    var d = diffOf(openPath);
    rowsNow = d ? parseDiff(d.text) : [];
    if (!d) { body.appendChild(h('div', 'none', 'Loading the diff\u2026')); return; }
    if (!rowsNow.length) { body.appendChild(h('div', 'none', 'No diff to show: the file is too large for GitHub to send, binary, or empty.')); return; }
    var lo = sel ? Math.min(sel.a, sel.b) : -1, hi = sel ? Math.max(sel.a, sel.b) : -1;
    var ext = openPath.indexOf('.') < 0 ? '' : openPath.split('.').pop();
    // highlight.js when it loaded and knows the language; otherwise the small tint of highlight()
    var lang = window.hljs ? langOf(ext) : '', htmls = lang && window.hljs.getLanguage(lang) ? htmlRows(rowsNow, lang, window.hljs) : [];
    var mine = pending.filter(function (c) { return c.path === openPath; }), placed = [];
    var anchor = {}; // row index -> the comments that end on it
    mine.forEach(function (c) {
      var last = c.lines[c.lines.length - 1], at = -1;
      rowsNow.forEach(function (r, i) { if (r.k !== 'h' && sameRow(r, last)) at = i; });
      if (at < 0) at = rowsNow.length - 1; // its lines moved on: it still shows, at the end
      (anchor[at] = anchor[at] || []).push(c);
    });
    var fAnchor = {};
    ((window.MAP && window.MAP.findings && window.MAP.findings[openPath]) || []).forEach(function (f) {
      var at = -1;
      if (f.line) rowsNow.forEach(function (r, i) { if (r.k !== 'h' && r.k !== 'd' && r.n === f.line) at = i; });
      if (at < 0) body.appendChild(findingEl(f)); // no line, or not in this diff: on the file
      else (fAnchor[at] = fAnchor[at] || []).push(f);
    });
    rowsNow.forEach(function (r, i) {
      if (r.k === 'h') { body.appendChild(h('div', 'row hunk', r.t)); return; }
      var row = h('div', 'row k-' + r.k + (i >= lo && i <= hi ? ' sel' : ''));
      row.setAttribute('data-i', String(i));
      row.onmouseenter = function () { if (selDrag) { sel = { a: sel.a, b: i }; paintSel(); } };
      [r.o, r.n].forEach(function (num) {
        var cell = h('span', 'ln', num == null ? '' : String(num));
        // Press on a number and drag down or up to take a range; shift-click extends the one already taken.
        cell.onmousedown = function (e) {
          if (e.button !== 0) return;
          e.preventDefault();
          if (e.shiftKey && sel) { sel = { a: sel.a, b: i }; renderDrawer(); return; }
          sel = { a: i, b: i }; draftText = ''; selDrag = true;
          var ed = document.querySelector('.editor'); if (ed) ed.remove();
          paintSel();
        };
        row.appendChild(cell);
      });
      row.appendChild(h('span', 'mark', r.k === 'a' ? '+' : r.k === 'd' ? '-' : ' '));
      var code = h('span', 'code');
      if (htmls[i] !== undefined) code.innerHTML = htmls[i];
      else highlight(r.t, ext).forEach(function (t) { code.appendChild(t[0] ? h('span', 't-' + t[0], t[1]) : document.createTextNode(t[1])); });
      row.appendChild(code);
      body.appendChild(row);
      (fAnchor[i] || []).forEach(function (f) { body.appendChild(findingEl(f)); });
      (anchor[i] || []).forEach(function (c) {
        var late = !c.sent && changedSince(c);
        var note = h('div', 'note' + (c.sent ? ' sent' : ''));
        note.appendChild(h('span', '', (c.sent ? '\u2713 ' : '') + c.text + (late ? '  (outdated: the file changed since)' : '')));
        var rm = h('button', '', '\u00d7'); rm.title = 'Remove this comment';
        rm.onclick = function () { pending = pending.filter(function (p) { return p.id !== c.id; }); savePending(); render(window.MAP); renderDrawer(); };
        note.appendChild(rm);
        body.appendChild(note);
      });
      if (i === hi) {
        var ed = h('div', 'editor'), ta = document.createElement('textarea');
        ta.placeholder = 'Comment on ' + (lo === hi ? 'this line' : 'these ' + picked().length + ' lines');
        ta.value = draftText;
        ta.oninput = function () { draftText = ta.value; };
        ta.onkeydown = function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); draft(false); } };
        ed.appendChild(ta);
        var btns = h('div', 'btns');
        [['Add to review', 'tab go', function () { draft(false); }], ['Send now', 'tab', function () { draft(true); }], ['Cancel', 'tab', function () { sel = null; draftText = ''; renderDrawer(); }]].forEach(function (b) {
          var now = EXPORTED && b[0] === 'Send now', bt = h('button', b[1], now ? 'Copy now' : b[0]); bt.onclick = b[2];
          if (now) btns.appendChild(modOnly(h('button', 'tab', 'Send now')));
          btns.appendChild(bt);
        });
        ed.appendChild(btns);
        body.appendChild(ed);
        setTimeout(function () { ta.focus(); }, 0);
      }
    });
    body.scrollTop = top;
    if (wantF != null) {
      var tgt = body.querySelector('[data-fid="' + wantF + '"]');
      wantF = null;
      if (tgt) {
        body.scrollTop += tgt.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 3;
        tgt.classList.add('seen');
        setTimeout(function () { tgt.classList.remove('seen'); }, 1600);
      }
    }
  }
  // diffs.js is read again only when data.js says its contents changed.
  function syncDiffs() {
    var rev = window.MAP && window.MAP.diffs && window.MAP.diffs.rev;
    if (EXPORTED || rev == null || rev === DIFFREV) return; // a snapshot carries its diffs
    var s = document.createElement('script');
    s.src = 'diffs.js?t=' + rev;
    s.onload = function () { DIFFREV = rev; s.remove(); sweep(); renderDrawer(); };
    s.onerror = function () { s.remove(); };
    document.head.appendChild(s);
  }

  var last = JSON.stringify(window.MAP), lastF = JSON.stringify(window.MAP && window.MAP.findings);
  render(window.MAP);
  syncDiffs();
  window.addEventListener('resize', function () { render(window.MAP); });
  window.addEventListener('hashchange', function () { render(window.MAP); });
  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) {
      if (e.key === 'Escape') { sel = null; draftText = ''; renderDrawer(); }
      return;
    }
    if (e.key === 'Escape') { if (focusId) setFocus(null); else closeDrawer(); }
    if (e.key === 'w') { location.hash = 'who'; render(window.MAP); }
    if (e.key === 'c') { location.hash = 'code'; render(window.MAP); }
    if (e.key === '0' || e.key === 'f') { view.auto = true; render(window.MAP); }
    if (e.key === 'r') { pos = {}; savePos(); render(window.MAP); }
  });
  if (!EXPORTED) {
    setInterval(function () {
      var s = document.createElement('script');
      s.src = 'data.js?t=' + Date.now();
      s.onload = function () {
        var now = JSON.stringify(window.MAP);
        if (now !== last) { last = now; syncDiffs(); if (dragging) stale = true; else render(window.MAP); var fnow = JSON.stringify(window.MAP && window.MAP.findings); if (fnow !== lastF) { lastF = fnow; if (!selDrag) renderDrawer(); } }
        s.remove();
      };
      s.onerror = function () { s.remove(); };
      document.head.appendChild(s);
    }, 1000);
  }
</script>
`
