# Changelog

All notable changes to Tether are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and Tether uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2]

### Changed

- The README lists what a clear gives you instead of quoting a fixed session size, which depends on each setup.

## [0.1.1]

### Changed

- The README leads with the automatic clear: why it saves tokens, how it works, and where it runs today.

## [0.1.0]

The first public release.

### Added

- `HANDOFF.md` injected at every session start (`startup`, `resume`, `clear`, `compact`).
- A context meter in the Stop hook and the `tether:checkpoint` skill, with the automatic clear on Windows and a
  "type /clear" prompt elsewhere.
- `scripts/squash.py` (plan, apply, verify) and the `tether:squash` skill.
- The `tether:handoff` and `tether:setup` skills.
- `lib/run.sh`, which runs the hooks and scripts with Python 3.10+ on Windows, macOS and Linux.
- Install from this repository, which is its own plugin marketplace.

[Unreleased]: https://github.com/Ryubara/tether/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Ryubara/tether/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Ryubara/tether/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Ryubara/tether/releases/tag/v0.1.0
