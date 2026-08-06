---
'critique': patch
---

Fix README navigation table to match actual keyboard shortcuts.

- Remove `←` / `→` (not implemented since scrollbox refactor)
- Fix `Ctrl+P` → `p` (no Ctrl modifier needed)
- Add missing shortcuts: `t` (theme picker), `q` (quit), `gg`/`G` (jump to top/bottom), `Ctrl+D`/`Ctrl+U` (half page scroll)

Fixes #48
