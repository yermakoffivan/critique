---
'critique': minor
---

Make `critique hunks` IDs stable across unrelated edits in the same file.

IDs are now a hash of the hunk's added and removed lines, not the `@@` line numbers. Another agent can insert or delete lines above or below your hunk without invalidating the ID you listed.

```bash
critique hunks list
critique hunks add 'src/main.ts:@a1b2c3d4e5f6'
```

Duplicate payloads in the same file get a suffix, including `.1`: `file:@<hash>.1`, `file:@<hash>.2`. That stops a leftover duplicate from stealing an unsuffixed ID. `hunks list` still prints the `@@` header under each ID so you can see where the hunk sits.

Existing `file:@-oldStart,...` IDs are no longer accepted. Run `critique hunks list` again before staging.

If a nearby edit **merges** two hunks, the hash changes and you need to list again.
