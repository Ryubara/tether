#!/bin/sh
# Runs one of Tether's Python scripts with the first Python 3.10+ found, on any system: `python3` (macOS, Linux),
# `python` or `py` (Windows). Claude Code runs hook command strings through sh, or Git Bash on Windows.
# Usage: sh lib/run.sh <script.py> [args...]
for candidate in python3 python py; do
    # The version check also skips Windows' Store stubs, which exist on PATH but only print an install hint.
    if command -v "$candidate" >/dev/null 2>&1 &&
        "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
        exec "$candidate" "$@"
    fi
done
echo "Tether: no Python 3.10 or newer found (tried python3, python, py)." >&2
exit 1
