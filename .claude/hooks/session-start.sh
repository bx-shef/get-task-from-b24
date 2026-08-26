#!/bin/bash
# SessionStart hook for Claude Code on the web: prepare the workspace so lint /
# typecheck / test work from the first turn.
#
# Skeleton: the stack is not fixed yet, so there is nothing to install. Fill this in
# together with the toolchain (see CLAUDE.md → "Стек" / "Команды").
set -euo pipefail

# Only needed in the remote (web) environment; local clones manage deps themselves.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# Example for a pnpm project — enable once package.json exists:
# corepack enable >/dev/null 2>&1 || true
# pnpm install --frozen-lockfile
