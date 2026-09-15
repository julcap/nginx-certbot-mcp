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
| `get_nginx_status` | ✅ implemented — running state (via sudo, doesn't depend on dbus) + version                            |
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
   exactly: `nginx -t`, `systemctl reload nginx`, `systemctl is-active
   --quiet nginx`, `certbot`, and the wrapper script above. Nothing
   broader. It also keeps
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

## Testing safely

Three layers, from "needs almost nothing" to "exercises everything":

### 1. Check/install dependencies

```bash
npm run check-deps
```

Debian/Ubuntu only. Idempotent: installs `nginx`, `certbot`,
`python3-certbot-nginx`, and `python3-certbot-dns-route53` if missing. If
they're already installed it only reports whether the installed version is
current or older than what's available — it never silently upgrades a
package that might already be serving traffic; it prints the `apt-get`
command to run yourself if you want that. Also reports your Node version
against the >=20 that `@aws-sdk/client-route-53` will eventually require.

### 2. Route 53 round-trip test

```bash
npm run test:dns
```

The only requirement is a working `ROUTE53_HOSTED_ZONE_ID` (+ AWS
credentials) in `.env` — you don't need to already own or know a test
subdomain, and nothing touches nginx or certbot. It discovers your zone's
own domain name from the hosted zone, creates a disposable CNAME under a
random subdomain (`mcp-test-<random>.<your-zone>`) pointing at the zone
apex, verifies it directly against Route 53 (and, best-effort, via public
DNS), then deletes it again — the cleanup runs even if a check in between
fails, so a bad run can't leave an orphaned record behind.

### 3. Docker sandbox (real nginx + certbot, disposable)

For exercising `create_site`, `reload_nginx`, `issue_cert`, etc. without
touching a real box. The container runs systemd as PID 1 so
`sudo systemctl reload nginx` and friends work exactly as they do in
production — that needs `--privileged` and a cgroup mount, which
`docker-compose.yml` already sets up:

```bash
cp .env.example .env   # fill in your AWS credentials + hosted zone ID
docker compose up -d --build
docker compose exec sandbox npm run inspect   # or see below for a real MCP client
```

`npm run inspect` prints a URL with a session token — open it in a browser.
It's running as `mcpuser` inside the container, with the wrapper + sudoers
already installed by `scripts/setup.sh` during the image build, and
`nginx`/`certbot`/the certbot plugins already installed via
`scripts/install-deps.sh`. Tear it down with `docker compose down`; nothing
it does persists once the container is gone (it's a fresh nginx/certbot
install every rebuild).

## Testing locally with the MCP Inspector

```bash
npm run inspect
```

This opens a browser UI where you can call each tool directly and see
raw input/output — much faster feedback loop than wiring it into Claude
Desktop for every change. Run it against your real box, or against the
Docker sandbox above (`docker compose exec sandbox npm run inspect`).

## Testing against Claude Desktop / claude.ai

Add to your MCP client config (path varies by client). Against a real box:

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

Or against the Docker sandbox, once it's running (`docker compose up -d`):

```json
{
  "mcpServers": {
    "nginx-certbot-sandbox": {
      "command": "docker",
      "args": ["exec", "-i", "nginx-certbot-mcp-sandbox", "node", "dist/index.js"]
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

1. `create_site`, `delete_site`, `restore_site`, `prune_archives`,
   `reload_nginx`, `get_nginx_status`, `tail_site_logs`, and
   `check_upstream_health` have all been exercised for real in the Docker
   sandbox. `issue_cert`, `issue_wildcard_cert`, `renew_cert`,
   `revoke_cert`, and `delete_cert` haven't (they need a publicly
   resolvable domain and port 80/443 reachable from Let's Encrypt, which
   the sandbox doesn't expose by default) — test those against **staging
   only** first, since flipping `staging:false` before you trust the flow
   risks burning your real Let's Encrypt rate limit.
2. `npm run test:dns` is a safe way to validate your AWS credentials and
   `ROUTE53_HOSTED_ZONE_ID` before trusting `create_domain_record` /
   `delete_domain_record` / `create_txt_record` against anything real.

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