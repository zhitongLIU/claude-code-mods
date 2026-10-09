---
name: mission-findings
description: Put the findings of a code review, from this conversation or an earlier one, on the Mission Control code map (files with findings turn pink, each finding shows under its line in the diff) so the reviewer can pick some and push them to the pull request. Works with any review, not only /code-review. Use when the user runs /mission-findings or asks to "add the review to mission control", "show the findings in the diff" or "mark the files pink".
---

# Mission findings

Turn a review that already exists in this conversation into the structured findings Mission Control draws. Do not review the code again.

## Steps

1. **Find the review.** Take the latest review in the conversation: a `ReportFindings` call, a list of issues in prose, or a table. If the user names one ("the first review", "only the high ones"), take that. If there is none, say so and stop; do not invent findings.

2. **Normalize each finding** to:
   - `file`: repo-relative path, as the review gave it. If it gave only a name, resolve it with Grep or Glob inside the reviewed repo.
   - `line`: 1-indexed line **in the new version of the file**, or leave it out for a finding on the whole file.
   - `summary`: one sentence, the defect.
   - `scenario`: the concrete inputs or state, then the wrong result. Keep it short.
   - `severity`: `high`, `medium` or `low`, or the review's own category. Leave it out if the review gave none.

3. **Check each line against the diff.** A review written a while ago can point at lines that moved. For a PR, run `gh pr diff <n>` (or `git diff <base>...HEAD -- <file>`) and confirm the line is part of the diff on the new side. If it moved, correct it when the code is plain to find; if it is not in the diff, drop `line` so the finding lands on the whole file. Never guess a line.

4. **Send them to Mission Control.** Call the `mcp__mission__findings` tool with `{ findings: [...] }`. Pass `add: true` only if the user asked to keep the findings already shown; the default replaces them.
   If that tool is not available (the mission mod is not loaded), write the array to a JSON file in the scratchpad and tell the user to run `/mission findings <that path>`.

5. **Report in one or two lines**: how many findings, how many sit on files the map shows. If some are on files that are not on the map, say that the page needs `/mission <PR link or base>` first to show those files.

## Pushing to the pull request

Do not push anything yourself. The reviewer ticks findings on the page and presses **Post to PR**, which posts them as one review of comments (no approval, no request for changes). That needs the page to be about a pull request (`/mission <PR link>`) and `gh` signed in.
