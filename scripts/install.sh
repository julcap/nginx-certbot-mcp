#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sudo install -m 0755 -o root -g root "$SCRIPT_DIR/nginx-mcp-writesite" /usr/local/bin/nginx-mcp-writesite