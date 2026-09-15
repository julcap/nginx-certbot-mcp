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
# package is often outdated), and on a box where that's actually the case,
# an apt-installed python3-certbot-dns-route53 is invisible to snap
# certbot's isolated Python environment ("The requested dns-route53 plugin
# does not appear to be installed", even though dpkg thinks it's there) -
# it needs the plugin installed as its own snap instead. But this is a
# heuristic, not a certainty (snapd might not be set up, might not have
# this snap available, etc.) - so it's a best-effort ADDITION, never a
# reason to skip the apt package. Whichever one actually works, works.
CERTBOT_PATH="$(command -v certbot 2>/dev/null || true)"
SNAP_PLUGIN_OK=false
if [ -n "$CERTBOT_PATH" ] && readlink -f "$CERTBOT_PATH" 2>/dev/null | grep -q '^/snap/'; then
  if snap list certbot-dns-route53 >/dev/null 2>&1; then
    echo "[certbot-dns-route53] up to date (snap plugin already installed)"
    SNAP_PLUGIN_OK=true
  elif $SUDO snap install certbot-dns-route53 2>&1; then
    $SUDO snap set certbot trust-plugin-with-root=ok
    SNAP_PLUGIN_OK=true
  else
    echo "[certbot] certbot looks like a snap install ($CERTBOT_PATH), but 'snap install" \
      "certbot-dns-route53' failed - falling back to the apt package below. It may or may not" \
      "be visible to snap certbot; if issue_wildcard_cert still fails after this, that's why." >&2
  fi
fi

PACKAGES=(
  nginx
  certbot
  python3-certbot-nginx        # certbot's nginx plugin - needed by issue_cert
)
# Only skip the apt plugin if the snap one is confirmed working - otherwise
# always install it, even if certbot looks like a snap, since a possibly-
# invisible plugin beats no plugin at all.
[ "$SNAP_PLUGIN_OK" = false ] && PACKAGES+=(python3-certbot-dns-route53)

echo "Refreshing apt package index..."
# `apt-get update` returns non-zero if ANY configured repo fails - including
# unrelated third-party ones (a stale PPA, a NodeSource repo pinned to the
# wrong release codename, etc.) that have nothing to do with the packages
# below. Don't let that abort the whole script: Ubuntu's own repos (where
# nginx/certbot/the plugins actually live) still get refreshed regardless,
# and the per-package check further down already reports clearly if a
# specific package genuinely isn't available.
if ! $SUDO apt-get update -qq; then
  echo "WARNING: apt-get update reported errors above (often a stale/unrelated third-party repo)" \
    "- continuing anyway, since Ubuntu's own repos may still be fine." >&2
fi

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
