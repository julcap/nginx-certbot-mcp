# nginx-certbot-mcp

[![CI](https://github.com/julcap/nginx-certbot-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/julcap/nginx-certbot-mcp/actions/workflows/ci.yml)

Let AI agents manage production web infrastructure without giving them root shell access.

nginx-certbot-mcp provisions Nginx reverse proxies, DNS records, and Let's
Encrypt certificates through narrowly scoped, auditable MCP tools — never
arbitrary shell commands. Privileged actions go through purpose-built
wrappers and least-privilege sudo rules (see [Why a wrapper
script](#why-a-wrapper-script-instead-of-sudo-on-teelnrm) below).

## Architecture

![nginx-certbot-mcp architecture](docs/architecture.png)

## Tools

All 26 are implemented and exercised against real infrastructure — see
[Testing](#testing).

| Tool | Description |
|---|---|
| `list_sites` | List configured nginx server blocks with domain, upstream, and SSL status |
| `get_site_config` | Raw nginx config for one domain |
| `check_cert_expiry` | List certbot-managed certs and days until expiry |
| `check_dns` | Resolve a domain (CNAME, then A/AAAA) against public resolvers |
| `check_upstream_health` | TCP probe of an upstream `host:port` |
| `get_nginx_status` | Whether nginx is running, plus its version |
| `diagnose_site` | One-call health report for a domain: config, nginx, DNS, upstream, certificate, recent errors — with suggested next tools |
| `tail_site_logs` | Tail access/error logs, capped at 1000 lines |
| `list_archived_sites` | List configs archived by `delete_site` |
| `list_site_backups` | List the automatic pre-change backups of site configs |
| `create_domain_record` | Upsert a Route 53 CNAME |
| `delete_domain_record` | Delete a Route 53 CNAME — `confirm:true` |
| `create_txt_record` | Upsert a Route 53 TXT record, e.g. for ACME DNS-01 |
| `delete_txt_record` | Delete a Route 53 TXT record — `confirm:true` |
| `create_site` | Create a websocket-capable nginx server block from the default template |
| `update_site` | Rewrite an existing site's `proxy_pass` upstream in place |
| `delete_site` | Disable, archive, and delete a server block — `confirm:true` |
| `restore_site` | Re-enable a site from its newest (or a chosen) archive — `confirm:true` |
| `rollback_site` | Undo a config change by restoring the newest (or a chosen) backup — `confirm:true` |
| `prune_archives` | Delete archives older than N days — `confirm:true` |
| `reload_nginx` | `nginx -t`, then reload only if it passes |
| `issue_cert` | Issue via HTTP-01 (`certbot --nginx`) — defaults to LE staging |
| `issue_wildcard_cert` | Issue `domain` + `*.domain` via DNS-01 (`certbot --dns-route53`) — defaults to LE staging |
| `renew_cert` | `certbot renew` — defaults to `--dry-run` |
| `revoke_cert` | Revoke with Let's Encrypt, leaving the files in place — `confirm:true` |
| `delete_cert` | Remove a cert's files from certbot's store — `confirm:true` |

## Setup

```bash
npm install
npm run build
npm run setup -- mcpuser
```

Run the server as a dedicated non-root user (e.g. `mcpuser`) — never as
root. `npm run setup -- <user>` (`scripts/setup.sh`) grants that user
exactly the privileges below, nothing more, and is idempotent: safe to
re-run any time, including after changing the username or pulling an
update that adds a new allowed command.

## Required permissions

`npm run setup -- <user>` installs two things:

1. **`/usr/local/bin/nginx-mcp-writesite`** — a narrow wrapper script that
   only accepts `{write|enable|disable|remove|archive|restore|remove-archive|backup|restore-backup}
   <domain>` or `log {access|error} <lines>`, and only ever touches paths
   under `/etc/nginx/sites-available/`, `/etc/nginx/sites-enabled/`,
   `/etc/nginx/sites-archived/`, `/etc/nginx/sites-backups/`, and the two
   fixed nginx log files. It re-validates the domain (and, for
   `restore`/`remove-archive`/`restore-backup`, the archive or backup
   filename) itself, independent of the Node-side validation.
2. **`/etc/sudoers.d/nginx-mcp`** — grants `<user>` passwordless sudo on
   exactly `nginx -t`, `systemctl reload nginx`, `systemctl is-active
   --quiet nginx`, `certbot`, and the wrapper above. Nothing broader. It
   also keeps `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/
   `AWS_DEFAULT_REGION` through sudo (which strips the environment by
   default) so `certbot --dns-route53` can see them for
   `issue_wildcard_cert`.

`issue_wildcard_cert` also needs the `certbot-dns-route53` plugin —
`npm run install:deps` installs it for you (see [Testing](#testing)).

## Why a wrapper script instead of sudo on tee/ln/rm

An earlier version granted sudo on generic file tools (`tee`, `ln`, `rm`)
so `create_site` could write into `/etc/nginx/`. That works, but it's a
wider trust boundary than the task needs: those commands can touch *any*
root-owned file on the box, not just nginx configs. If the MCP server
process were ever compromised or triggered unexpectedly, the blast radius
would be the whole filesystem.

The wrapper narrows that to one purpose-built binary that can only act on
nginx site configs, one archive at a time, or tail one of two fixed log
files — nothing else. The trade-off is one more artifact to deploy and
keep in sync with the server, in exchange for sudo that can only ever do
what this project needs.

## Network requirements for certificate issuance

![HTTP-01 and DNS-01 network requirements](docs/certificate-network-requirements.svg)

`issue_cert` and `issue_wildcard_cert` prove domain ownership two
different ways, with different requirements on where the box sits on your
network:

- **`issue_cert` (HTTP-01)** — Let's Encrypt makes an inbound HTTP request
  to the domain on port 80. If you're behind a home/office router doing
  NAT, that request lands on whichever **one** private IP your
  port-forwarding rule targets. The machine running nginx (and this MCP
  server) has to be that exact machine — not just any box on your network,
  and not the Docker sandbox (a different private IP on the Docker bridge
  network). Calling it from the wrong box fails every time, since the
  challenge request never arrives.
- **`issue_wildcard_cert` (DNS-01)** — validates via a TXT record
  `certbot-dns-route53` creates in Route 53. This is outbound-only (the
  box calls the AWS API; nothing calls back in), so it has no
  port-forwarding requirement and works identically from any network,
  including the Docker sandbox.

Either way, DNS still has to point at your public IP (`create_domain_record`
handles that) — DNS and port-forwarding are two separate requirements, and
`issue_cert` needs both.

## Safety controls

Beyond the per-tool `confirm` gates and staging-by-default, the server has
operator-level controls that an agent can't turn off from inside a
conversation. Everything is configured through environment variables (see
[Environment variables](#environment-variables)).

### Audit log

Every mutating tool call is appended to a JSONL file — timestamp, tool,
arguments, MCP client, whether it was a dry run, outcome, and a one-line
result — including calls that were refused. Credentials in arguments are
redacted and long values truncated.

```json
{"ts":"2026-09-19T10:02:11.402Z","tool":"delete_site","mutating":true,"client":"claude-code/2.1.0","args":{"domain":"old.example.com","confirm":true},"dry_run":false,"outcome":"ok","message":"Removed \"old.example.com\" (disabled, archived ...","duration_ms":212}
```

`outcome` is `ok`, `failed` (the tool ran and reported `success:false`,
including an unconfirmed dry run), `error` (it threw), or `denied`.

- Default path is `~/.nginx-certbot-mcp/audit.jsonl` (mode `0600`); override
  with `AUDIT_LOG_PATH`, or set `AUDIT_LOG_PATH=off` to disable.
- The server refuses to start if the log isn't writable — you find out at
  startup, not after the first change.
- Read-only calls are skipped by default; set `AUDIT_LOG_READS=true` to
  include them.
- The file grows forever; point `logrotate` at it if that matters.

### Read-only mode and tool allowlist

Hand an agent visibility without write access, or expose only the tools a
workflow needs. Tools that are switched off are never registered, so the
agent can't see or call them.

```bash
MCP_MODE=readonly                       # only tools annotated read-only
MCP_ENABLED_TOOLS="check_*,list_sites"  # only these (* is a wildcard)
```

- `MCP_MODE` is `readwrite` (default) or `readonly`. Read-only mode drops
  every tool that changes state — DNS, nginx config, certificates, reloads.
- `MCP_ENABLED_TOOLS` is a comma-separated list of tool names or `*`
  patterns. When both are set, a tool must pass both.
- An invalid `MCP_MODE`, or an allowlist entry that matches no tool, is
  reported on stderr at startup (the former is fatal) rather than silently
  exposing the wrong set.

### Domain allowlist

Confine the agent to the domains it's meant to manage, so a confused or
manipulated agent can't edit, delete, or issue certificates for anything
else on the box.

```bash
ALLOWED_DOMAINS="example.com,*.example.com"
```

- `example.com` matches exactly that name; `*.example.com` matches any
  subdomain at any depth, **not** the apex — list both if you want both.
  A bare TLD (`*.com`) is rejected at startup.
- Applies to every tool's `domain` argument, read-only tools included, and
  to Route 53 record names (`_acme-challenge.a.example.com` matches
  `*.example.com`).
- `issue_wildcard_cert` for `example.com` also covers `*.example.com`, so
  both must be allowed.
- Listings (`list_sites`, `check_cert_expiry`, `list_archived_sites`) only
  show in-scope domains, and `prune_archives` only touches in-scope
  archives.
- `renew_cert` and `tail_site_logs` normally act on everything when
  `domain` is omitted; with an allowlist they require one.
- Refused calls return a `Denied by policy` error and are written to the
  audit log with outcome `denied`.

This limits which *domains* the tools act on; it doesn't change what the
`sudo` rules permit the server user to do — see
[Required permissions](#required-permissions).

### Config backups and rollback

`create_site`, `update_site`, `restore_site` and `rollback_site` snapshot
a site's existing config before changing it, and each one restores that
snapshot itself if the new config fails `nginx -t` — so a broken change
never stays on disk. Backups also cover the case `nginx -t` can't catch: a
config that is *valid* but wrong (the wrong upstream, say).

- `list_site_backups` shows the snapshots, newest first; `rollback_site`
  restores the newest one by default (the config as it was before the last
  change) or a chosen `backup_filename`. It needs `confirm:true`.
- Rolling back snapshots the current config first, so calling it again
  flips back — a rollback is never a one-way door.
- The newest 10 backups per domain are kept in
  `/etc/nginx/sites-backups/`; older ones are deleted automatically.
- If a snapshot can't be taken, the change is refused rather than made
  without a safety net. After upgrading, re-run `npm run setup -- <user>`
  so the installed helper knows the `backup` action.
- Backups are separate from `delete_site`'s archives: those are "this site
  was deleted", backups are "what it looked like before the last change".
- `reload_nginx` still only reloads a config that passes `nginx -t`; when
  it refuses, its `hint` points at `rollback_site`.

### Production issuance guard

Let's Encrypt's production rate limits punish retry loops, and a lockout can
last a week. `issue_cert` and `issue_wildcard_cert` keep a local history of
production (`staging:false`) attempts and refuse a request that would
exceed a limit — before spending it:

| Limit | Guard refuses when |
|---|---|
| Duplicate certificates | 5 certs for the exact same set of names in 7 days |
| Failed validations | 5 failed validations for a name in 1 hour |
| Certificates per registered domain | 50 certs for one registered domain in 7 days |

A refusal says which limit was hit and when to retry; a `Heads-up` note in
`rate_limit_note` appears as a limit gets close. Staging requests are never
counted or refused.

- It counts only what was issued through this server, so it's a guard rail,
  not a substitute for Let's Encrypt's own limits. "Registered domain" is
  approximated from the last two labels (three under `co.uk`-style suffixes).
- Only failures that reached validation count towards the failed-validation
  limit; a missing sudo rule or a missing nginx block doesn't.
- History lives in `issuance.json` under `MCP_STATE_DIR` (default
  `~/.nginx-certbot-mcp/`, mode `0600`) and is pruned after 7 days. Set
  `RATE_LIMIT_GUARD=off` to disable the guard.

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `create_domain_record`, `delete_domain_record`, `create_txt_record`, `issue_wildcard_cert` | Credentials for a Route-53-scoped IAM user — no other AWS permissions needed |
| `ROUTE53_HOSTED_ZONE_ID` | `create_domain_record`, `delete_domain_record`, `create_txt_record` | Find with `aws route53 list-hosted-zones-by-name --dns-name julcap.net` |
| `AWS_DEFAULT_REGION` | Same as above, plus `issue_wildcard_cert` | Optional — Route 53 is global, but the AWS SDK/boto3 still need a signing region; defaults to `us-east-1` |
| `AUDIT_LOG_PATH` | All mutating tools | Optional — audit log file; default `~/.nginx-certbot-mcp/audit.jsonl`, `off` disables. See [Audit log](#audit-log) |
| `MCP_MODE` | All tools | Optional — `readwrite` (default) or `readonly`. See [Read-only mode](#read-only-mode-and-tool-allowlist) |
| `MCP_ENABLED_TOOLS` | All tools | Optional — comma-separated tool names / `*` patterns to expose; default all |
| `ALLOWED_DOMAINS` | All tools taking a `domain` | Optional — comma-separated `example.com` / `*.example.com` entries the agent may act on; default any. See [Domain allowlist](#domain-allowlist) |
| `RATE_LIMIT_GUARD` | `issue_cert`, `issue_wildcard_cert` | Optional — `off` disables the [production issuance guard](#production-issuance-guard) |
| `MCP_STATE_DIR` | `issue_cert`, `issue_wildcard_cert` | Optional — where the guard keeps its issuance history; default `~/.nginx-certbot-mcp` |
| `AUDIT_LOG_READS` | Read-only tools | Optional — `true` also audits read-only calls |

## Testing

Four layers, from "needs almost nothing" to "exercises everything":

### 1. Dependencies — `npm run install:deps`

Debian/Ubuntu only, idempotent. Installs `nginx`, `certbot`,
`python3-certbot-nginx`, and `python3-certbot-dns-route53` via apt if
missing; for anything already installed, it only reports whether the
version is current, since silently upgrading a package that might be
serving traffic isn't this script's call to make. If `certbot` looks like
a **snap** install (common — certbot's own docs recommend it over apt's
often-outdated package), it also tries installing `certbot-dns-route53` as
a snap plugin, since an apt-installed plugin can be invisible to snap
certbot's isolated Python environment. That's best-effort and additive,
never a replacement for the apt package, so `issue_wildcard_cert` has a
working path either way. Also reports your Node version against the
`>=20` that `@aws-sdk/client-route-53` will eventually require.

### 2. Route 53 round trip — `npm run test:dns`

The only requirement is a working `ROUTE53_HOSTED_ZONE_ID` (+ AWS
credentials) in `.env`. It discovers your zone's own domain from the
hosted zone, creates a disposable CNAME under a random subdomain, verifies
it (directly against Route 53, and best-effort via public DNS), then
deletes it — cleanup runs even if a check in between fails, so a bad run
can't leave an orphaned record.

### 3. Docker sandbox — real nginx + certbot, disposable

```bash
cp .env.example .env   # fill in AWS credentials + hosted zone ID
docker compose up -d --build
docker compose exec sandbox npm run inspect
```

The container runs systemd as PID 1, so `sudo systemctl reload nginx` and
friends work exactly as they do in production (needs `--privileged` and a
cgroup mount, which `docker-compose.yml` already sets up). `nginx`/
`certbot`/the plugins are installed via `install-deps.sh`, and the
wrapper/sudoers via `setup.sh`, both at image build time. Tear down with
`docker compose down` — nothing persists; every rebuild is a fresh install.

### 4. Automated tool-by-tool suite

```bash
cp .env.test.example .env.test   # AWS credentials + a domain you control
npm run test:tools                # against the Docker sandbox
npm run test:tools:host           # against this machine directly
```

Drives every tool over the real stdio JSON-RPC protocol and prints
✓/✗/– per tool. `.env.test` is separate from `.env` — read on the host and
injected directly into each MCP server process the runner spawns, so the
two files never need to match. Before touching anything it verifies your
AWS credentials work and that `TEST_DOMAIN` is the zone's apex or a
subdomain of it. Everything then runs under a random
`mcp-test-<random>.<TEST_DOMAIN>` subdomain, self-cleans after each phase,
and does a final best-effort cleanup regardless of pass/fail. Certificate
issuance is opt-in — asked interactively, or pass `--certs` for a
non-interactive run — since it hits real Let's Encrypt staging and adds a
minute or two.

The two targets differ in exactly one way, `issue_cert`:

- **`npm run test:tools`** (default) runs in the Docker sandbox, which
  isn't reachable from the internet, so `issue_cert` (HTTP-01) is always
  skipped — the cert scenario only exercises `issue_wildcard_cert`
  (DNS-01) and the renew/revoke/delete chain built on it.
- **`npm run test:tools:host`** runs `node dist/index.js` directly on this
  machine. If this is the box your router actually forwards 80/443 to,
  the cert scenario tests `issue_cert` too (waiting up to 300s for the
  disposable CNAME to propagate first), and the renew/revoke/delete chain
  runs against *that* cert instead. It refuses to start unless
  passwordless sudo already works for the current user — i.e.
  `npm run setup -- <user>` was run for the user actually invoking it, not
  some other account. **Everything this touches is real production
  state**, not a sandbox.

## Connecting a client

**MCP Inspector** — the fastest feedback loop for poking at a tool
directly:

```bash
npm run inspect
```

Prints a URL with a session token. Run it against a real box, or the
Docker sandbox (`docker compose exec sandbox npm run inspect`).

**Claude Desktop / claude.ai** — add to your MCP client config:

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

Or against the running Docker sandbox:

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

## Diagnosing a site

When a site misbehaves, start with `diagnose_site` instead of calling the
individual checks one by one. It runs, in parallel, and reports each as
`ok` / `warn` / `fail` / `skipped`:

| Check | Looks at |
|---|---|
| `config` | config exists, is enabled, `server_name` matches, upstream and SSL parsed out |
| `nginx` | service running, and `nginx -t` passes |
| `dns` | the domain resolves (CNAME, then A/AAAA) |
| `upstream` | the `proxy_pass` target accepts a TCP connection |
| `certificate` | a certbot cert covers the domain (wildcards included), days left, and that the config actually uses it |
| `recent_errors` | the latest nginx error-log lines mentioning the domain or its upstream |

The result also has an overall `healthy` flag (no check failed — warnings
and skipped checks don't count) and `next_steps`: the specific tools that
would fix each problem, e.g. `create_domain_record` for a domain that
doesn't resolve or `rollback_site` after a config that no longer passes
`nginx -t`. A check that can't run (say, certbot isn't installed) is
reported as `skipped` with the reason; it doesn't sink the rest.

It is read-only, so it's available in `MCP_MODE=readonly`, and it respects
`ALLOWED_DOMAINS`.

## Typical "add a new site" flow

1. `create_domain_record` — point `mysite.julcap.net` at `www.julcap.net`
2. (wait for DNS propagation)
3. `create_site` — nginx serves the domain on port 80, reverse-proxied to
   the local service IP:port
4. `reload_nginx`
5. `issue_cert` — certbot validates via HTTP-01, updates nginx to redirect
   to 443

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for
guidelines.

## License

nginx-certbot-mcp is source-available under the [Elastic License
2.0](LICENSE). You may use, modify, and redistribute the software.
However, you may not provide a substantial portion of its functionality
to third parties as a hosted or managed service.

For commercial licensing or partnership enquiries, contact the maintainer.

## TODO

Planned, not yet implemented:

- [ ] **`provision_site` workflow tool** — DNS record, nginx site, reload and
  certificate in one call, rolling back the steps already taken if a later
  one fails. Today the agent has to sequence the
  [add-a-site flow](#typical-add-a-new-site-flow) itself.
- [ ] **Certificate expiry alerts** — a `warn_days` threshold on
  `check_cert_expiry` and an optional webhook (Slack / Discord) for
  certificates that are close to expiring.
- [ ] **Per-site options in `create_site`** — custom headers, client body
  size, rate limiting, basic auth, IP allowlist, HTTP→HTTPS redirect, HSTS,
  and a choice of named templates instead of the single default one.
- [ ] **More DNS providers** — Cloudflare first, alongside Route 53 (certbot
  already has DNS plugins for it), so the DNS and DNS-01 tools aren't tied to
  AWS.
