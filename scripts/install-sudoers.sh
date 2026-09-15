#!/usr/bin/env bash
# Installs the sudoers rule that lets the MCP server's user run nginx -t,
# reload/query nginx via systemctl, run certbot, and invoke the
# nginx-mcp-writesite wrapper without a password prompt - nothing broader
# than that. Also keeps AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/
# AWS_DEFAULT_REGION through sudo (sudo strips the environment by default)
# so `certbot --dns-route53` can see them for issue_wildcard_cert - nothing
# else is preserved.
#
# What it does:
#   1. Writes the intended sudoers line to a temp file.
#   2. Validates that file's syntax with `visudo -c` before it touches
#      anything real - a syntax error here can never corrupt sudo itself,
#      since /etc/sudoers.d/nginx-mcp is only written after this check passes.
#   3. Installs it as its own file under /etc/sudoers.d/ (mode 0440, root-owned)
#      rather than editing /etc/sudoers directly, so it can't interfere with
#      any other sudoers rules already on the box.
#
# Safe to run multiple times:
#   - If /etc/sudoers.d/nginx-mcp already exists with the exact content this
#     script would write, it exits immediately without touching visudo or
#     install at all - re-running it is a no-op, not just harmless.
#   - If the content differs (e.g. you changed the username, or a future
#     edit adds another command to the allowed list), it re-validates and
#     overwrites - so it also serves as the "update" path, not just first-time
#     setup.
#   - The temp file is always cleaned up on exit (success, failure, or the
#     no-op early-exit) via the trap below, so repeated runs never leave
#     stray files behind.
set -euo pipefail

USER_NAME="${1:?Usage: $0 <username-to-grant>}"
SUDOERS_FILE="/etc/sudoers.d/nginx-mcp"
TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

cat > "$TMP_FILE" <<EOF
$USER_NAME ALL=(root) NOPASSWD: /usr/sbin/nginx -t, /usr/bin/systemctl reload nginx, /usr/bin/systemctl is-active --quiet nginx, /usr/bin/certbot, /usr/local/bin/nginx-mcp-writesite
Defaults:$USER_NAME env_keep += "AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION"
EOF

# Already installed with identical content? Nothing to do.
if sudo test -f "$SUDOERS_FILE" && sudo cmp -s "$TMP_FILE" "$SUDOERS_FILE"; then
  echo "$SUDOERS_FILE already up to date for user $USER_NAME - nothing to do."
  exit 0
fi

# visudo -c validates syntax without touching the real sudoers files.
if ! sudo visudo -c -f "$TMP_FILE"; then
  echo "Syntax check failed - not installing. See errors above." >&2
  exit 1
fi

sudo install -m 0440 -o root -g root "$TMP_FILE" "$SUDOERS_FILE"
echo "Installed $SUDOERS_FILE for user $USER_NAME"