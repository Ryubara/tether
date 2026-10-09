# Security

## What counts

Tether runs code on your machine when Claude Code starts a session and when a turn ends, so report anything that
lets untrusted input harm a person using it, for example:

- a crafted `HANDOFF.md`, transcript or state file that makes a hook run a command or write outside its state
  directory;
- the automatic clear typing into a console other than the session's own;
- the squash script rewriting, deleting or pushing anything it was not asked to.

Ordinary bugs go in a normal issue.

## Report a vulnerability

Use GitHub's **Report a vulnerability** button under the repository's Security tab. Please do not open a public
issue or pull request for a vulnerability. Include what you found, the affected version or commit, your operating
system and Claude Code version, and the steps to reproduce it.

## What happens next

A maintainer will acknowledge the report, confirm whether it is a vulnerability, and work on a fix in private. The
fix is published together with a note crediting you, unless you prefer to stay anonymous.

## Supported versions

The latest release.
