# nginx-certbot-mcp

Let AI agents manage production web infrastructure without giving them root shell access.

nginx-certbot-mcp is a safety-first MCP server for provisioning Nginx reverse proxies, DNS records and Let's Encrypt certificates through narrowly scoped, auditable operations.

Instead of exposing arbitrary shell commands, privileged actions are restricted through purpose-built wrappers and least-privilege sudo rules.

## Architecture

![nginx-certbot-mcp architecture](docs/architecture.png)

## Status

| Tool | Status                                                                                                 |
|---|--------------------------------------------------------------------------------------------------------|
| `list_sites` | ✅ implemented                                                                                         |
| `get_site_config` | ✅ implemented                                                                                         |
| `check_cert_expiry` | ✅ implemented                                                                                         |
| `check_dns` | ✅ implemented — resolves CNAME, then A/AAAA                                                           |
| `check_upstream_health` | ✅ implemented — TCP probe of host:port                                                                |
| `get_nginx_status` | ✅ implemented — running state + version, no sudo needed                                               |
| `tail_site_logs` | ✅ implemented — access/error log tail, capped at 1000 lines; `domain` filter is best-effort           |
| `list_archived_sites` | ✅ implemented                                                                                         |
| `create_domain_record` | ✅ implemented — Route 53 CNAME via UPSERT                                                             |
| `delete_domain_record` | ✅ implemented — Route 53 CNAME delete; requires `confirm:true`                                        |
| `create_txt_record` | ✅ implemented — Route 53 TXT via UPSERT, e.g. for ACME DNS-01                                         |
| `create_site` | ✅ implemented — writes/tests/enables via the `nginx-mcp-writesite` wrapper (see Required permissions) |
| `delete_site` | ✅ implemented — disables, archives to `sites-archived`, then deletes; requires `confirm:true`         |
| `restore_site` | ✅ implemented — re-enables from the newest (or a chosen) archive; requires `confirm:true`             |
| `prune_archives` | ✅ implemented — deletes archives older than N days; requires `confirm:true`                           |
| `reload_nginx` | ✅ implemented                                                           |
| `issue_cert` | 🚧 partly implemented — defaults to LE staging, includes a DNS pre-check                              |
| `issue_wildcard_cert` | 🚧 partly implemented — needs certbot-dns-route53 installed on the box (see Required permissions)     |
| `renew_cert` | ✅ implemented — `certbot renew`, defaults to `--dry-run`                                              |
| `revoke_cert` | ✅ implemented — leaves cert files on disk; requires `confirm:true`                                    |
| `delete_cert` | ✅ implemented — removes cert files from certbot's store; requires `confirm:true`                      |


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
   only accepts `{write|enable|disable|remove|archive|restore|remove-archive} <domain>`
   or `log {access|error} <lines>`, and only ever touches paths under
   `/etc/nginx/sites-available/`, `/etc/nginx/sites-enabled/`,
   `/etc/nginx/sites-archived/`, and the two fixed nginx log files. It
   re-validates the domain (and, for `restore`/`remove-archive`, the archive
   filename) itself, independent of the Node-side validation.
2. **`/etc/sudoers.d/nginx-mcp`** — grants `mcpuser` passwordless sudo on
   exactly: `nginx -t`, `systemctl reload nginx`, `certbot`, and the
   wrapper script above. Nothing broader. It also keeps
   `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` through sudo (which strips
   the environment by default) so `certbot --dns-route53` can see them for
   `issue_wildcard_cert` — no other environment variables are preserved.

`issue_wildcard_cert` additionally needs the `certbot-dns-route53` plugin
installed on the box (e.g. `apt install python3-certbot-dns-route53`) —
this repo doesn't install it for you.

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `create_domain_record`, `delete_domain_record`, `create_txt_record`, `issue_wildcard_cert` | Credentials for a Route-53-scoped IAM user — no other AWS permissions needed |
| `ROUTE53_HOSTED_ZONE_ID` | `create_domain_record`, `delete_domain_record`, `create_txt_record` | Find with `aws route53 list-hosted-zones-by-name --dns-name julcap.net` |

## Why a wrapper script instead of sudo on tee/ln/rm

An earlier version of this granted sudo on generic file tools (`tee`, `ln`,
`rm`) so `create_site` could write into `/etc/nginx/`. That works,
but it's a wider trust boundary than the task needs — those commands can
touch *any* root-owned file on the box, not just nginx site configs. If the
MCP server process were ever compromised or triggered unexpectedly, the
blast radius would be the whole filesystem.

The wrapper script narrows that: sudo is scoped to one purpose-built binary
that can only write, enable, disable, remove, archive, or restore a single
named site config, prune one named archive, or tail one of the two fixed
nginx log files — nothing else. The trade-off is one more artifact to
deploy and keep in sync with the server, in exchange for sudo that can only
ever do the things this project needs.

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
3. `create_site` — nginx serves the domain on port 80, reverse-proxied
   to the local service IP:port
4. `reload_nginx`
5. `issue_cert` — certbot validates via HTTP-01, updates nginx to redirect to 443

## Next steps

1. Test `issue_cert` / `issue_wildcard_cert` against **staging only** first —
   flipping `staging:false` against production before you trust the flow
   risks burning your real Let's Encrypt rate limit.
2. None of the tools above have been exercised against a real box yet —
   dry-run `renew_cert`, and try the destructive ones (`delete_site`,
   `restore_site`, `prune_archives`, `revoke_cert`, `delete_cert`,
   `delete_domain_record`) against a non-critical domain first.
3. Install the `certbot-dns-route53` plugin before trying `issue_wildcard_cert`
   — see Required permissions.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for guidelines.

## License

nginx-certbot-mcp is source-available under the
[Elastic License 2.0](LICENSE).

You may use, modify, and redistribute the software. However, you may not
provide a substantial portion of its functionality to third parties as a
hosted or managed service.

For commercial licensing or partnership enquiries, contact the maintainer.