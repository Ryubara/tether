---
name: checkpoint
description: Use when the Tether Stop hook says the context is large ("checkpoint at the next safe point"), or at a natural boundary when the context is large -- saves the state to HANDOFF.md and has the session cleared and resumed with no one at the keyboard.
---

# tether:checkpoint

A checkpoint resets the context deliberately instead of letting autocompact summarise it: you save the state to
`HANDOFF.md`, Tether types `/clear` into this session, and the fresh session gets `HANDOFF.md` at start and the
prompt `Continue from HANDOFF.md.`

1. **Safe point.** Dispatch nothing new. Prefer a moment when no agent is running: `/clear` does not stop
   background agents, and their completion notices do reach the cleared session, but it kills the shell command
   an agent is running at that moment (exit 137; the agent then carries on or retries). If you cannot wait, go
   ahead: every running agent must be in HANDOFF's **Running** section with what it is for and how to collect or
   check its result if the notice never arrives.
2. **HANDOFF.md.** Write its **Resume** section: what just happened, the exact next action, and as its last line
   "Once this is done, delete this Resume section." (the fresh session does not load this skill). Bring the rest
   up to date (tether:handoff). Commit it with the work unless the project keeps it untracked or ignored.
3. **Request the clear.** Run `sh "<this skill's base directory>/../../lib/run.sh" "<this skill's base directory>/../../lib/tether.py" request-clear`, then end
   your turn at once, with no further tool calls.

When the turn ends, the Stop hook clears the session (Windows), or tells the user to type `/clear` and then
`Continue from HANDOFF.md.`
