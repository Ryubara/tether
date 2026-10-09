---
name: handoff
description: Use when the project's state changes (an agent dispatched or finished, a decision made, a step done) or before ending a session -- keeps HANDOFF.md, the project's one state file, current for a reader with no context.
---

# tether:handoff

`HANDOFF.md` at the project root is the session's whole memory across `/clear`: Tether puts it into the context at
every session start. Keep it current; what is done leaves it (git history and the project's docs hold that).

Sections, in order (start from `template.md` beside this file if the file is missing):

- **Resume** -- only right after a checkpoint: what just happened and the exact next action. Remove it once acted on.
- **Now** -- where the work stands, in a few bullets: branch, what works, what is half done.
- **Running** -- background agents and long jobs: what, where (worktree, branch, log), and how to collect the
  result if its notice never arrives (its report file, `git log` of its branch).
- **Next** -- ordered steps.
- **Waiting on the user** -- decisions and actions only the user can take.
- **Decisions** -- one dated line per decision still in force, newest first, with who made it; prune when no
  longer relevant.

Rules:

- Update it whenever the picture changes, not only at the end.
- Under ~150 lines. Write for a reader who knows nothing of this session: names, paths and commands, not "as above".
- Commit it with the work it describes, or on its own, following the project's conventions -- unless the project
  keeps HANDOFF.md untracked or ignored, in which case just save it.
