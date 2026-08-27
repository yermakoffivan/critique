---
'critique': patch
---

List the commits a diff contains before rendering or uploading it. A rebased branch can carry commits replayed from a sibling branch, which makes the merge base too far back and silently publishes work you did not write.

The summary shows the commit count, file count, line totals, the commits in the range, the commit the diff starts from, and a note when uncommitted work is included. It appears for commit ranges, `--commit`, and any ref compared to the working tree. Long ranges are truncated, but the oldest commits are always kept, because a rebase replays a foreign commit right above the base.

`critique A..B` and `critique <ref>` compare two trees directly, so on diverged branches they also undo the commits that exist only on the base side. Those commits are now listed under a `reversed from` heading with an explicit warning. `critique A...B` and `critique A B` start at the merge base, so the `base:` line names the merge base instead of the ref.

Silence the list with `--no-commit-list`. With `--json` the summary goes to stderr and `commits` plus `reversedCommits` arrays are added to the payload.
