# Diff review drawer for the Mission Control code map

## Goal

On the Code tab, clicking a changed box opens that file's diff in a drawer that slides up from the bottom, so the map stays visible above it. The user selects one or more lines, comments on them, and either collects the comments into a pending review or sends one right away. "Send" copies formatted text to the clipboard for the user to paste into their Claude session. Nothing is sent to the session directly.

## Decisions

- **Send path: clipboard only.** The page is a static `file://` page the plugin writes to (`data.js`, re-read every second); it cannot reach into the session. A local server or `cmux browser eval` polling is out of scope.
- **Diffs load lazily** from a separate `diffs.js`, so the 1s `data.js` poll does not grow.
- **Drawer, not a replacement view.** The map remains visible and interactive above the drawer.

## Plugin side (`hooks/register.tsx`, new `hooks/diff.ts`)

- For every file that is changed (`changedTurn > 0` or `review`), run `git diff` against the review base (`HEAD` for a live turn, the given base for `/mission-review`; untracked files via `--no-index /dev/null`).
- `data.js` gains `diffs: { rev, paths }`: `paths` names who has a diff (those boxes are clickable) and `rev` is a hash of the diffs, so the page re-reads `diffs.js` only when it changes.
- Write the result to `diffs.js` as `window.DIFFS = { "<path>": "<unified diff>" }`, only when its JSON differs from the last write (same guard as `data.js`).
- `diff.ts` exports pure functions: `parseDiff(text)` returns hunks of lines `{ kind: 'ctx'|'add'|'del', old?: number, new?: number, text }`, and `formatComment(path, lines, text)` returns the copy text.

## Page side (`hooks/template.ts`)

- **Open and close.** Clicking a changed box opens the drawer on that file (kept in the page, not the URL hash). It closes when the user clicks the same box again, clicks the empty part of the page above the drawer, or presses Esc. Clicking a different changed box switches the drawer to that file. Boxes that are not changed do nothing.
- **Layout.** The drawer takes the bottom ~45% of the window with a header (path, close button). The map area shrinks to the top part; zoom/pan/drag still work there. The box of the open file is highlighted.
- **Diff.** Unified view with old and new line numbers, add/delete colouring, and hunk headers.
- **Selecting lines.** Click a line number to select it; shift-click extends the range. Selection opens an inline comment box under the range with "Add to review" and "Send now".
- **Pending review.** Held in `localStorage`, keyed by the page path like the box positions, so it survives refreshes. A bar at the top of the page shows "Send review (n)" and "Discard"; it is hidden when empty. Comments already on a file show as markers in the drawer.
- **Copy format.** Per comment:

  ```
  path:L12-15
  > quoted line
  > quoted line

  comment text
  ```

  A review is its comments joined by a blank line, with a short header. "Send now" copies one comment in the same format. The quoted code stays in the text so it still reads correctly if the file shifts.
- **Clipboard fallback.** `navigator.clipboard.writeText`, then `document.execCommand('copy')`, then a `prompt()` box holding the text. A toast confirms "Copied, paste into Claude".
- **Stale diff.** If a refresh changes a file's diff while a comment box is open, keep the open box and its range.

## Testing

- `diff.ts` unit tests: parsing hunks, added/deleted/renamed/untracked files, line numbering, `formatComment` for single lines, ranges and deleted lines.
- Engine tests: `diffs.js` is written only when diffs change, and not at all when nothing is changed.
- The page script is a string in `template.ts`, so it cannot import `diff.ts`. The formatter is inlined into the template by stringifying the function, so the tested code is the shipped code.

## Out of scope

Pushing text into the session, replies from Claude, resolving comments, comments on files that are not changed.

## Implementation notes

- A remote pull request link stores GitHub's patch (no headers, none at all for very large files: the drawer says so) and a ref `PR #N (base) owner/repo@sha` that heads the copied text.
- Live-turn diffs come from `git diff HEAD` per edited file; a new file git does not know reads as all added. Outside a git repo a box has no diff and is not clickable.
- The page script cannot be eval-checked in the test sandbox; the template test checks it carries the shipped `parseDiff`/`formatReview` source, and the page was driven in a browser.
