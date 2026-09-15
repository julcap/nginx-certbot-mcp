# nginx-certbot-mcp

MCP server for reading nginx config and managing reverse proxy hosts + SSL
certs via certbot. See `../nginx-mcp-tool-spec.md` for the full design.

## Status

| Tool | Status |
|---|---|
| `list_sites` | ✅ implemented |
| `get_site_config` | ✅ implemented |
| `check_cert_expiry` | ✅ implemented |
| `create_domain_record` | ✅ implemented — Route 53 CNAME via UPSERT |
| `create_server_block` | ✅ implemented — writes/tests/enables via the `nginx-mcp-writesite` wrapper (see Required permissions) |
| `reload_nginx` | ✅ implemented — needs sudoers entry below |
| `issue_cert` | ✅ implemented — needs sudoers entry, defaults to LE staging |
| `remove_site` | ⬜ not started |
| `renew_cert` | ⬜ not started |

The read-only tools are real and safe to run against your actual nginx setup
right now. The mutating ones are intentionally left as guarded stubs — finish
the TODOs once you've reviewed the guardrail logic and are comfortable with it.

## Setup

```bash
npm install
npm run build
npm run setup -- mcpuser
```

## Required permissions

Run this server as a dedicated non-root user (e.g. `mcpuser`) — do NOT run
the whole server as root.

Set up permissions with:

```bash
npm run build
npm run setup -- mcpuser
```
This installs two things:

1. **`/usr/local/bin/nginx-mcp-writesite`** — a narrow wrapper script that
   only accepts `{write|enable|disable|remove} <domain>` and only ever
   touches paths under `/etc/nginx/sites-available/` and
   `/etc/nginx/sites-enabled/`. It re-validates the domain itself,
   independent of the Node-side validation.
2. **`/etc/sudoers.d/nginx-mcp`** — grants `mcpuser` passwordless sudo on
   exactly: `nginx -t`, `systemctl reload nginx`, `certbot`, and the
   wrapper script above. Nothing broader.

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `create_domain_record` | Credentials for a Route-53-scoped IAM user — no other AWS permissions needed |
| `ROUTE53_HOSTED_ZONE_ID` | `create_domain_record` | Find with `aws route53 list-hosted-zones-by-name --dns-name julcap.net` |

## Why a wrapper script instead of sudo on tee/ln/rm

An earlier version of this granted sudo on generic file tools (`tee`, `ln`,
`rm`) so `create_server_block` could write into `/etc/nginx/`. That works,
but it's a wider trust boundary than the task needs — those commands can
touch *any* root-owned file on the box, not just nginx site configs. If the
MCP server process were ever compromised or triggered unexpectedly, the
blast radius would be the whole filesystem.

The wrapper script narrows that: sudo is scoped to one purpose-built binary
that can only write, enable, disable, or remove a single named site config
— nothing else. The trade-off is one more artifact to deploy and keep in
sync with the server, in exchange for sudo that can only ever do the one
thing this project needs.

Both installer scripts (`scripts/install.sh`, `scripts/install-sudoers.sh`)
are idempotent — safe to re-run `npm run setup -- mcpuser` any time,
including after you change the username or add a new allowed command.

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

## Typical "add a new site" flow

1. `create_domain_record` — point `mysite.julcap.net` at `www.julcap.net`
2. (wait for DNS propagation)
3. `create_server_block` — nginx serves the domain on port 80, reverse-proxied
   to the local service IP:port
4. `reload_nginx`
5. `issue_cert` — certbot validates via HTTP-01, updates nginx to redirect to 443

## Next steps

1. Test `issue_cert` against **staging only** first — flipping `staging:false`
   against production before you trust the flow risks burning your real
   Let's Encrypt rate limit.
2. Add `remove_site` and `renew_cert`, following the same pattern as the
   existing tools (validate → dry-run/test → confirm-required for anything
   destructive) and routed through `nginx-mcp-writesite` where they touch
   `/etc/nginx/`.
