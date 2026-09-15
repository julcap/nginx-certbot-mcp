#!/usr/bin/env bash
# Runs the full first-time (or repeat, since both steps are idempotent)
# setup: installs the nginx-mcp-writesite wrapper, then grants the given
# user sudo access to exactly the commands this server needs.
set -euo pipefail

# npm passes everything after -- as positional args

USER_NAME="${1:?Usage: npm run setup -- <username>}"

bash scripts/install.sh
bash scripts/install-deps.sh
bash scripts/install-sudoers.sh "$USER_NAME"