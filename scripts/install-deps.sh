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

# certbot's own docs recommend installing it via snap rather than apt (apt's
# package is often outdated) - many boxes already have it that way. snap
# certbot is a fully isolated Python environment, so an apt-installed
# python3-certbot-dns-route53 is completely invisible to it ("The requested
# dns-route53 plugin does not appear to be installed", even though dpkg
# thinks it's there) - it needs the plugin installed as its own snap instead.
CERTBOT_IS_SNAP=false
CERTBOT_PATH="$(command -v certbot 2>/dev/null || true)"
if [ -n "$CERTBOT_PATH" ] && readlink -f "$CERTBOT_PATH" 2>/dev/null | grep -q '^/snap/'; then
  CERTBOT_IS_SNAP=true
fi

if [ "$CERTBOT_IS_SNAP" = true ]; then
  if snap list certbot-dns-route53 >/dev/null 2>&1; then
    echo "[certbot-dns-route53] up to date (snap plugin already installed)"
  else
    echo "[certbot] is a snap install ($CERTBOT_PATH) - installing certbot-dns-route53 as a snap" \
      "plugin instead of via apt (the apt package would be invisible to snap certbot)."
    $SUDO snap install certbot-dns-route53
  fi
  $SUDO snap set certbot trust-plugin-with-root=ok
  if dpkg-query -W python3-certbot-dns-route53 >/dev/null 2>&1; then
    echo "[certbot] NOTE: python3-certbot-dns-route53 is also installed via apt, but snap certbot" \
      "can't see it - it's dead weight, not a conflict. Safe to leave or 'sudo apt-get remove' it."
  fi
fi

PACKAGES=(
  nginx
  certbot
  python3-certbot-nginx        # certbot's nginx plugin - needed by issue_cert
)
# Skip the apt dns-route53 plugin entirely when certbot is a snap install -
# see above, it would just be inert weight, not a working plugin.
[ "$CERTBOT_IS_SNAP" = false ] && PACKAGES+=(python3-certbot-dns-route53)

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
