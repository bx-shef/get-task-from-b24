#!/bin/bash
# SessionStart hook for Claude Code on the web: install dependencies so lint /
# typecheck / test work from the first turn.
# Synchronous on purpose — guarantees deps are ready before the session starts.
set -euo pipefail

# Only needed in the remote (web) environment; local clones manage deps themselves.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# corepack ships the pnpm version pinned in package.json's "packageManager".
corepack enable >/dev/null 2>&1 || true

# Idempotent: a no-op when the store and node_modules are current.
pnpm install --frozen-lockfile
