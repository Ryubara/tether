#!/bin/sh
# Fails when the plugin's version, the changelog's newest entry and a release tag (if given) disagree.
# Usage: scripts/check-version.sh [vX.Y.Z-tag]
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$root/.claude-plugin/plugin.json" | head -n 1)
[ -n "$version" ] || { echo "no version in .claude-plugin/plugin.json" >&2; exit 1; }
newest=$(sed -n 's/^## \([0-9][^ ]*\).*/\1/p' "$root/CHANGELOG.md" | head -n 1)
[ "$newest" = "$version" ] || { echo "plugin.json says $version, the newest CHANGELOG entry says ${newest:-nothing}" >&2; exit 1; }
if [ "$#" -ge 1 ]; then
  [ "${1#v}" = "$version" ] || { echo "tag $1 does not match plugin.json $version" >&2; exit 1; }
fi
echo "version $version matches"
