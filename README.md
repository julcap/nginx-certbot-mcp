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
   broader. It also keeps `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/
   `AWS_DEFAULT_REGION` through sudo (which strips the environment by
   default) so `certbot --dns-route53` can see them for
   `issue_wildcard_cert` — no other environment variables are preserved.

`issue_wildcard_cert` additionally needs the `certbot-dns-route53` plugin
installed on the box (e.g. `apt install python3-certbot-dns-route53`) —
this repo doesn't install it for you.

## Network requirements for certificate issuance

![HTTP-01 and DNS-01 network requirements](docs/certificate-network-requirements.svg)

`issue_cert` and `issue_wildcard_cert` validate domain ownership two
completely different ways, with different requirements on where the box
sits on your network:

- **`issue_cert` (HTTP-01)** — Let's Encrypt makes an inbound HTTP request
  to the domain on port 80. That request goes to whatever your DNS resolves
  the domain to (its public IP), and if you're behind a home/office router
  doing NAT, the router then forwards it to **exactly one** private IP per
  port-forwarding rule. This means: the machine running nginx (and this MCP
  server) has to be the *specific* private IP your router forwards 80/443
  to — not just any machine on your network, and not the Docker sandbox
  (which sits at its own, different private IP on the Docker bridge
  network). If you run multiple boxes/VMs behind one router, double-check
  which one the port-forwarding rule actually targets before calling
  `issue_cert` from it; calling it from the wrong box fails every time,
  since the challenge request never reaches it.
- **`issue_wildcard_cert` (DNS-01)** — validates by having `certbot-dns-route53`
  create a TXT record in Route 53 for Let's Encrypt to look up. This is
  outbound-only (the box calls the AWS API; nothing calls back in), so it
  has no port-forwarding requirement at all and works identically from any
  network, including the Docker sandbox.

Either way, the domain's DNS still has to actually point at your public IP
(`create_domain_record` handles that part) - DNS pointing correctly and
port-forwarding pointing correctly are two separate requirements, and
`issue_cert` needs both.

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `create_domain_record`, `delete_domain_record`, `create_txt_record`, `issue_wildcard_cert` | Credentials for a Route-53-scoped IAM user — no other AWS permissions needed |
| `ROUTE53_HOSTED_ZONE_ID` | `create_domain_record`, `delete_domain_record`, `create_txt_record` | Find with `aws route53 list-hosted-zones-by-name --dns-name julcap.net` |
| `AWS_DEFAULT_REGION` | `create_domain_record`, `delete_domain_record`, `create_txt_record`, `issue_wildcard_cert` | Optional — Route 53 is global, but the AWS SDK/boto3 still need a signing region; defaults to `us-east-1` if unset |

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

Four layers, from "needs almost nothing" to "exercises everything":

### 1. Check/install dependencies

```bash
npm run install:deps
```

Debian/Ubuntu only. Idempotent: installs `nginx`, `certbot`,
`python3-certbot-nginx`, and `python3-certbot-dns-route53` if missing. If
`certbot` turns out to already be a **snap** install (common - certbot's own
docs recommend snap over apt's often-outdated package), it installs
`certbot-dns-route53` as a snap plugin instead: an apt-installed plugin is
completely invisible to snap certbot's isolated Python environment, which
surfaces later as `issue_wildcard_cert` failing with "The requested
dns-route53 plugin does not appear to be installed" even though `dpkg`
thinks it's there. If packages are already installed it only reports
whether the version is current or older than what's available — it never
silently upgrades a package that might already be serving traffic; it
prints the `apt-get`
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

### 4. Automated tool-by-tool test suite

```bash
cp .env.test.example .env.test   # fill in AWS credentials + a domain you control
npm run test:tools               # against the Docker sandbox
npm run test:tools:host          # against this machine directly
```

Drives every registered MCP tool over the real stdio JSON-RPC protocol -
the same way a real MCP client would - and prints ✓/✗/– per tool.
`.env.test` is separate from `.env`: it's read on the host, and its
credentials get injected directly into each MCP server process the runner
spawns, so `.env` and `.env.test` never need to match.

Before touching anything it verifies your AWS credentials work and that
`TEST_DOMAIN` is actually the zone's apex or a subdomain of it - refusing
to run against a domain the hosted zone doesn't control. Everything then
runs under a random `mcp-test-<random>.<TEST_DOMAIN>` subdomain, self-cleans
after each phase, and does a final best-effort cleanup pass regardless of
what passed or failed. You'll be asked once, interactively, whether to also
exercise certificate issuance - it hits real Let's Encrypt staging and adds
a minute or two, so it's opt-in (pass `--certs` for a non-interactive run,
e.g. `npm run test:tools:host -- --certs`).

Two targets, with one real difference - `issue_cert` (HTTP-01):

- **`npm run test:tools`** (default) - the Docker sandbox. Starts it via
  `docker compose up -d --build` if it isn't already running (`.env` only
  has to exist for that, and gets created blank from `.env.example`
  automatically if missing). Disposable and self-contained, but not
  reachable from the internet on port 80, so `issue_cert` is always
  skipped - only `issue_wildcard_cert` (DNS-01, `renew_cert`, `revoke_cert`,
  `delete_cert` get exercised as part of the cert scenario.
- **`npm run test:tools:host`** - runs `node dist/index.js` directly on
  this machine instead of in Docker. This is the only way to test
  `issue_cert` for real, since it needs the box that's actually reachable
  on port 80/443 (see Network requirements above) - if this is that box,
  the cert scenario tests `issue_cert` too, waiting up to 300s (10 attempts,
  30s apart) for the disposable CNAME to propagate before attempting it.
  **Everything this
  touches is real production state, not a sandbox** - real nginx config,
  real certbot, real DNS - so treat it accordingly. It refuses to run at
  all unless passwordless sudo already works for the user running it (i.e.
  you've run `npm run setup -- <user>` for that user already).

`renew_cert`'s dry-run has occasionally hung past its timeout during
development (certbot holds a global lock while it's running, and a
client-side timeout can't kill the remote process) - if a run seems stuck,
check for and kill any stray `certbot` process, then `docker compose down`
(sandbox) to start clean.

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

1. `npm run test:tools` is the most thorough way to validate a change - it's
   caught real bugs already (e.g. `get_nginx_status` assuming a D-Bus
   session that isn't guaranteed to exist). `issue_cert` (HTTP-01) is
   always skipped since the sandbox isn't publicly reachable on port 80 by
   default; test it manually against **staging only** first if you need to,
   since flipping `staging:false` before you trust the flow risks burning
   your real Let's Encrypt rate limit.
2. `npm run test:dns` is a narrower, faster check of just the Route 53
   round trip if you don't need the full suite.

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