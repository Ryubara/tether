# Security

## What counts

Report anything that lets untrusted input harm a person using Tether, for example:

- a hook or poller that runs a command from a project file without the user having approved it
- an unsafe default, such as a network service listening without being asked to;
- a flaw in the build, CI or release process that could ship tampered artifacts.

Ordinary bugs go in a normal issue.

## How to report

Open a private security advisory on the repository (Security tab, "Report a vulnerability").

Please give a way to reproduce the problem and say which version you used. We aim to answer within
7 days.
