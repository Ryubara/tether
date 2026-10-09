---
name: setup
description: Use when the user wants Tether in a project, or a project has no HANDOFF.md or no project rules in AGENTS.md -- prepares HANDOFF.md, CLAUDE.md and AGENTS.md once, filled in with the user.
---

# tether:setup

Run once per project; afterwards the files are the project's, not Tether's.

1. **HANDOFF.md.** Ask the user whether HANDOFF.md is tracked in git or ignored (ignored keeps it out of a public
   repository). If missing, create it from `../handoff/template.md` (relative to this skill's base directory) with
   the current state. If ignored, add `HANDOFF.md` to `.gitignore` when it is not already there.
2. **CLAUDE.md** must contain the line `@AGENTS.md`; add it (create the file if needed) without touching the rest.
3. **AGENTS.md.** If it lacks project rules, add the skeleton from `agents-template.md` beside this file and fill
   it in with the user: read the repository first (build files, CI, existing docs, `git log` titles), propose
   each section, and ask only about what you cannot find. Keep what AGENTS.md already says; merge, do not
   duplicate. Target under ~60 lines: AGENTS.md is in the context of every request.
4. Commit the changes following the project's conventions (HANDOFF.md only if tracked), after showing the user.
