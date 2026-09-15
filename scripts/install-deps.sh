#!/usr/bin/env bash
# Idempotently ensures nginx, certbot, and the certbot plugins this project
# needs are present (Debian/Ubuntu, apt-based).
#
# - Missing package -> installed.
# - Already installed -> reported only (up to date, or older than what's
#   available) - never silently upgraded. Upgrading nginx/certbot on a box
#   already serving traffic is a judgment call for a human, not this script;
#   it prints the exact command to run if you want to.
#
# Safe to run as root (e.g. during `docker build`) or as a sudo-capable user.
set -euo pipefail

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

PACKAGES=(
  nginx
  certbot
  python3-certbot-nginx        # certbot's nginx plugin - needed by issue_cert
  python3-certbot-dns-route53  # needed by issue_wildcard_cert
)

echo "Refreshing apt package index..."
$SUDO apt-get update -qq

status=0

for pkg in "${PACKAGES[@]}"; do
  installed="$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || true)"
  candidate="$(apt-cache policy "$pkg" 2>/dev/null | awk '/Candidate:/{print $2}')"

  if [ -z "$candidate" ] || [ "$candidate" = "(none)" ]; then
    echo "[$pkg] not found via apt - is the right repository enabled?" >&2
    status=1
    continue
  fi

  if [ -z "$installed" ]; then
    echo "[$pkg] not installed - installing $candidate..."
    $SUDO apt-get install -y "$pkg"
  elif [ "$installed" = "$candidate" ]; then
    echo "[$pkg] up to date ($installed)"
  else
    echo "[$pkg] installed ($installed) is older than the available $candidate - not upgrading automatically."
    echo "        Run: sudo apt-get install --only-upgrade $pkg"
  fi
done

echo
if command -v node >/dev/null 2>&1; then
  node_version="$(node --version)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  if [ "$node_major" -lt 20 ]; then
    echo "[node] $node_version is older than the Node 20 that @aws-sdk/client-route-53 will" \
      "require after early 2027 - not upgrading automatically (system Node vs nvm is your call)."
  else
    echo "[node] $node_version - OK"
  fi
else
  echo "[node] not found - install Node.js 20+ before running this MCP server." >&2
  status=1
fi

exit "$status"
