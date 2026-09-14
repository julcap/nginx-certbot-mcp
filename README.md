# nginx-certbot-mcp

MCP server for reading nginx config and managing reverse proxy hosts + SSL
certs via certbot. See `../nginx-mcp-tool-spec.md` for the full design.

## Status

| Tool | Status |
|---|---|
| `list_sites` | ✅ implemented |
| `get_site_config` | ✅ implemented |
| `check_cert_expiry` | ✅ implemented |
| `create_server_block` | 🚧 stubbed — validated + renders template, actual write/test-swap is a TODO in `src/tools/createServerBlock.ts` |
| `reload_nginx` | 🚧 needs sudoers entry (see below) before it'll work |
| `issue_cert` | 🚧 needs sudoers entry, defaults to LE staging |
| `remove_site` | ⬜ not started |
| `renew_cert` | ⬜ not started |

The read-only tools are real and safe to run against your actual nginx setup
right now. The mutating ones are intentionally left as guarded stubs — finish
the TODOs once you've reviewed the guardrail logic and are comfortable with it.

## Setup

```bash
npm install
npm run build
```

## Required permissions

The mutating tools shell out to `nginx -t`, `systemctl reload nginx`, and
`certbot`. Run this server as a dedicated non-root user with a narrow
sudoers entry — do NOT run the whole server as root:

```
# /etc/sudoers.d/nginx-mcp
mcpuser ALL=(root) NOPASSWD: /usr/sbin/nginx -t, /usr/bin/systemctl reload nginx, /usr/bin/certbot
```

## Testing locally with the MCP Inspector

```bash
npm run inspect
```

This opens a browser UI where you can call each tool directly and see
raw input/output — much faster feedback loop than wiring it into Claude
Desktop for every change.

## Testing against Claude Desktop / claude.ai

Add to your MCP client config (path varies by client):

```json
{
  "mcpServers": {
    "nginx-certbot": {
      "command": "node",
      "args": ["/absolute/path/to/nginx-certbot-mcp/dist/index.js"]
    }
  }
}
```

## Next steps

1. Test `list_sites` / `get_site_config` / `check_cert_expiry` against your
   real `/etc/nginx` — these should work as-is (read-only, no sudo needed).
2. Review and finish the TODO in `createServerBlock.ts` (temp-file → test →
   move-into-place → symlink flow).
3. Set up the sudoers entry, then test `reload_nginx`.
4. Test `issue_cert` against **staging only** first — flipping `staging:false`
   against production before you trust the flow risks burning your real rate
   limit.
5. Add `remove_site` and `renew_cert` following the same pattern as the
   existing tools (validate → dry-run/test → confirm-required for anything
   destructive).
