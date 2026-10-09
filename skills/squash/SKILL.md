---
name: squash
description: Use when a working branch's many small commits should become a few feature-sized ones before a push or at a milestone -- groups them with the squash script, which keeps the tree byte-identical and tags the old tip.
---

# tether:squash

The script is `sh "<this skill's base directory>/../../lib/run.sh" "<this skill's base directory>/../../scripts/squash.py"`; it does the git work exactly, you do
the grouping and the words.

1. `squash.py plan <base>` lists the commits in `base..HEAD` (hash, title, files). Base is usually the last
   pushed commit (`origin/<branch>`) or the branch point.
2. Group them into feature-sized commits, in the order a reader should see them. Write the proposal as a JSON
   file outside the repository (or in an ignored path):
   `{"base": "<base>", "groups": [{"commits": ["<hash>", ...], "message": "<title>\n\n<body>"}, ...]}`.
   Every commit appears exactly once; reordering is allowed. Messages follow the project's Conventions section in
   AGENTS.md.
3. Show the proposal to the user and wait for approval, unless the project says squashing is delegated.
4. `squash.py apply <proposal>`. A conflict, a missing commit or a different tree refuses and changes nothing:
   regroup and retry. On success it prints the tag holding the old tip (`squash/<branch>/<time>`).
5. `squash.py verify <tag>` repeats the tree check at any later time.

Untracked and ignored files (HANDOFF.md, if the project ignores it) are never touched. A branch that was already
pushed needs a force-push after a squash: that is the user's call.
