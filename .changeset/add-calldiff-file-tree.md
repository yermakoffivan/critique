---
'critique': minor
---

Add the experimental `--calldiff` option for reviewing function call-flow changes with the line diff.

```bash
critique --calldiff
critique main HEAD --calldiff --web "Call flow changes"
```

Changed call trees appear below their source files in the top file tree. The same view is available in the interactive TUI, terminal scrollback, web previews, PDFs, and images.

Set `CRITIQUE_CALLDIFF=1` to enable call-stack diffs by default without passing the option on every command.
