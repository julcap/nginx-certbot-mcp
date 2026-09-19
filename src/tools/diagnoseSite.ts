import { readFile, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { NGINX_SITES_AVAILABLE, NGINX_SITES_ENABLED } from "../config.js";
import { assertValidDomain, assertValidUpstreamHost, assertValidPort } from "../validate.js";
import { checkDomainResolution, type DnsCheckResult } from "../dns.js";
import { parseSiteConfig } from "./listSites.js";
import { getNginxStatus, type NginxStatus } from "./getNginxStatus.js";
import { checkUpstreamHealth, type CheckUpstreamHealthResult } from "./checkUpstreamHealth.js";
import { checkCertExpiry, certCoversDomain, type CertStatus } from "./checkCertExpiry.js";
import { tailSiteLogs } from "./tailSiteLogs.js";

const execFileAsync = promisify(execFile);

export type CheckStatus = "ok" | "warn" | "fail" | "skipped";

export interface Check {
  status: CheckStatus;
  detail: string;
}

export interface DiagnoseResult {
  domain: string;
  healthy: boolean; // no check failed (warnings and skipped checks don't count)
  summary: string;
  checks: {
    config: Check & { enabled?: boolean; upstream?: string | null; ssl_enabled?: boolean };
    nginx: Check & { running?: boolean; version?: string; config_test_passed?: boolean };
    dns: Check & { record_type?: string; values?: string[] };
    upstream: Check;
    certificate: Check & { cert_name?: string; expires_at?: string; days_remaining?: number };
    recent_errors: Check & { lines: string[] };
  };
  next_steps: string[];
}

// Everything the diagnosis touches is behind this, so the verdict logic can be
// tested without nginx, certbot or a network.
export interface DiagnoseDeps {
  readConfig(domain: string): Promise<string | null>;
  isEnabled(domain: string): Promise<boolean>;
  nginxStatus(): Promise<NginxStatus>;
  nginxConfigTest(): Promise<{ ok: boolean; output: string }>;
  resolve(domain: string): Promise<DnsCheckResult>;
  probeUpstream(host: string, port: number): Promise<CheckUpstreamHealthResult>;
  certificates(): Promise<CertStatus[]>;
  errorLog(lines: number): Promise<string[]>;
}

const defaultDeps: DiagnoseDeps = {
  readConfig: (domain) => readFile(path.join(NGINX_SITES_AVAILABLE, domain), "utf-8").catch(() => null),
  isEnabled: (domain) =>
    lstat(path.join(NGINX_SITES_ENABLED, domain)).then(
      () => true,
      () => false
    ),
  nginxStatus: getNginxStatus,
  nginxConfigTest: async () => {
    try {
      const { stdout, stderr } = await execFileAsync("sudo", ["nginx", "-t"]);
      return { ok: true, output: stdout + stderr };
    } catch (err: any) {
      return { ok: false, output: err.stderr ?? String(err) };
    }
  },
  resolve: checkDomainResolution,
  probeUpstream: (host, port) => checkUpstreamHealth({ upstream_host: host, upstream_port: port }),
  certificates: checkCertExpiry,
  errorLog: async (lines) => {
    const result = await tailSiteLogs({ log_type: "error", lines });
    if (!result.success) throw new Error(result.note ?? "could not read the nginx error log");
    return result.lines;
  },
};

const CERT_WARN_DAYS = 14;
const LOG_LINES_SCANNED = 500;
const LOG_LINES_SHOWN = 10;

// "http://10.0.0.5:3000" -> { host, port }. Anything else (unix sockets, named
// upstream blocks, nginx variables) isn't something a TCP probe can test.
export function parseUpstream(proxyPass: string | null): { host: string; port: number } | null {
  const m = proxyPass?.match(/^(https?):\/\/([A-Za-z0-9.-]+)(?::(\d+))?(?:\/.*)?$/);
  if (!m) return null;
  const port = m[3] ? Number(m[3]) : m[1] === "https" ? 443 : 80;
  return { host: m[2], port };
}

// One failing check shouldn't sink the whole report.
async function guarded<T extends Check>(name: string, run: () => Promise<T>, fallback: () => T): Promise<T> {
  try {
    return await run();
  } catch (err: any) {
    const failed = fallback();
    failed.status = "skipped";
    failed.detail = `${name} check could not run: ${err.message ?? err}`;
    return failed;
  }
}

export async function diagnoseSite(domain: string, deps: DiagnoseDeps = defaultDeps): Promise<DiagnoseResult> {
  assertValidDomain(domain);
  // Collected per check and flattened in a fixed order at the end, since the
  // checks run concurrently and would otherwise push in whatever order they finish.
  const steps: Record<keyof DiagnoseResult["checks"], string[]> = {
    config: [], nginx: [], dns: [], upstream: [], certificate: [], recent_errors: [],
  };

  // --- config (everything else that's site-specific hangs off this) ---
  const content = await deps.readConfig(domain);
  const enabled = content !== null && (await deps.isEnabled(domain));
  const parsed = content !== null ? parseSiteConfig(content) : null;

  let config: DiagnoseResult["checks"]["config"];
  if (parsed === null) {
    config = { status: "fail", detail: `No nginx config for "${domain}" in sites-available.`, enabled: false };
    steps.config.push(`create_site to add an nginx server block for ${domain}.`);
  } else if (!enabled) {
    config = {
      status: "fail",
      detail: `A config exists but isn't enabled (no entry in sites-enabled), so nginx isn't serving it.`,
      enabled: false, upstream: parsed.upstream, ssl_enabled: parsed.ssl_enabled,
    };
    steps.config.push(`Re-run create_site with the same upstream to re-enable ${domain}, then reload_nginx.`);
  } else if (parsed.server_name && !parsed.server_name.split(/\s+/).includes(domain)) {
    config = {
      status: "warn",
      detail: `Enabled, but its server_name is "${parsed.server_name}", which doesn't include ${domain}.`,
      enabled: true, upstream: parsed.upstream, ssl_enabled: parsed.ssl_enabled,
    };
    steps.config.push(`get_site_config for ${domain} and check its server_name.`);
  } else {
    config = {
      status: "ok",
      detail: `Enabled; proxies to ${parsed.upstream ?? "(no proxy_pass found)"}; SSL ${parsed.ssl_enabled ? "configured" : "not configured"}.`,
      enabled: true, upstream: parsed.upstream, ssl_enabled: parsed.ssl_enabled,
    };
  }
  const sslEnabled = parsed?.ssl_enabled ?? false;
  const upstream = parseUpstream(parsed?.upstream ?? null);

  // --- the rest are independent of one another ---
  const [nginx, dns, upstreamCheck, certificate, recentErrors] = await Promise.all([
    guarded<DiagnoseResult["checks"]["nginx"]>(
      "nginx",
      async () => {
        const [status, test] = await Promise.all([deps.nginxStatus(), deps.nginxConfigTest()]);
        if (!status.running) {
          steps.nginx.push("nginx isn't running: check `systemctl status nginx`, then reload_nginx once `nginx -t` passes.");
          return { status: "fail", detail: "nginx is not running.", running: false, version: status.version, config_test_passed: test.ok };
        }
        if (!test.ok) {
          steps.nginx.push("nginx -t is failing, so the next reload will be refused. See checks.nginx.detail for the error; if a recent change caused it, list_site_backups then rollback_site.");
          return { status: "fail", detail: `nginx is running but \`nginx -t\` fails: ${test.output.trim()}`, running: true, version: status.version, config_test_passed: false };
        }
        return { status: "ok", detail: `nginx is running (${status.version}) and its config passes \`nginx -t\`.`, running: true, version: status.version, config_test_passed: true };
      },
      () => ({ status: "skipped", detail: "" })
    ),

    guarded<DiagnoseResult["checks"]["dns"]>(
      "DNS",
      async () => {
        const r = await deps.resolve(domain);
        if (!r.resolves) {
          steps.dns.push(`create_domain_record to point ${domain} at this server, then wait for DNS to propagate (check_dns).`);
          return { status: "fail", detail: `${domain} does not resolve.` };
        }
        return { status: "ok", detail: `Resolves via ${r.record_type}: ${(r.values ?? []).join(", ")}.`, record_type: r.record_type, values: r.values };
      },
      () => ({ status: "skipped", detail: "" })
    ),

    guarded<Check>(
      "upstream",
      async () => {
        if (!upstream) {
          return { status: "skipped", detail: parsed ? `Can't TCP-probe upstream "${parsed.upstream ?? "none"}" (not a plain http(s)://host[:port]).` : "No config to read an upstream from." };
        }
        assertValidUpstreamHost(upstream.host);
        assertValidPort(upstream.port);
        const r = await deps.probeUpstream(upstream.host, upstream.port);
        if (!r.reachable) {
          steps.upstream.push(`Upstream ${upstream.host}:${upstream.port} is unreachable: check the service is running there, or update_site to point at the right one.`);
          return { status: "fail", detail: r.message };
        }
        return { status: "ok", detail: r.message };
      },
      () => ({ status: "skipped", detail: "" })
    ),

    guarded<DiagnoseResult["checks"]["certificate"]>(
      "certificate",
      async () => {
        const certs = await deps.certificates();
        const cert = certs.find((c) => certCoversDomain(c.domains ?? [c.domain], domain));
        if (!cert) {
          if (sslEnabled) {
            steps.certificate.push(`The config references SSL but certbot has no certificate for ${domain}: issue_cert (or issue_wildcard_cert), or the next reload may fail.`);
            return { status: "fail", detail: `SSL is configured but certbot has no certificate covering ${domain}.` };
          }
          steps.certificate.push(`issue_cert to serve ${domain} over HTTPS (staging first).`);
          return { status: "warn", detail: `No certificate covers ${domain}; the site is HTTP-only.` };
        }
        const shared = { cert_name: cert.domain, expires_at: cert.expires_at, days_remaining: cert.days_remaining };
        if (cert.days_remaining <= 0) {
          steps.certificate.push(`The certificate has expired: renew_cert for ${cert.domain} (dry run first).`);
          return { status: "fail", detail: `Certificate "${cert.domain}" expired ${-cert.days_remaining} day(s) ago.`, ...shared };
        }
        if (cert.days_remaining < CERT_WARN_DAYS) {
          steps.certificate.push(`Certificate expires in ${cert.days_remaining} days and auto-renewal hasn't run: renew_cert for ${cert.domain}.`);
          return { status: "warn", detail: `Certificate "${cert.domain}" expires in ${cert.days_remaining} days.`, ...shared };
        }
        if (!sslEnabled) {
          steps.certificate.push(`A valid certificate exists but the site config has no SSL block: issue_cert for ${domain} lets certbot wire it in.`);
          return { status: "warn", detail: `Certificate "${cert.domain}" is valid (${cert.days_remaining} days) but the site config doesn't use it.`, ...shared };
        }
        return { status: "ok", detail: `Certificate "${cert.domain}" is valid for ${cert.days_remaining} more days.`, ...shared };
      },
      () => ({ status: "skipped", detail: "" })
    ),

    guarded<DiagnoseResult["checks"]["recent_errors"]>(
      "error log",
      async () => {
        const needles = [domain, ...(upstream ? [`${upstream.host}:${upstream.port}`] : [])];
        const matching = (await deps.errorLog(LOG_LINES_SCANNED)).filter((l) => needles.some((n) => l.includes(n)));
        if (matching.length === 0) {
          return { status: "ok", detail: `No errors mentioning ${domain}${upstream ? ` or its upstream` : ""} in the last ${LOG_LINES_SCANNED} error-log lines.`, lines: [] };
        }
        steps.recent_errors.push("Read recent_errors for the failure pattern; tail_site_logs shows more.");
        return {
          status: "warn",
          detail: `${matching.length} error-log line(s) mention this site or its upstream; showing the latest ${Math.min(matching.length, LOG_LINES_SHOWN)}.`,
          lines: matching.slice(-LOG_LINES_SHOWN),
        };
      },
      () => ({ status: "skipped", detail: "", lines: [] })
    ),
  ]);

  const checks = { config, nginx, dns, upstream: upstreamCheck, certificate, recent_errors: recentErrors };
  const all = Object.values(checks);
  const count = (s: CheckStatus) => all.filter((c) => c.status === s).length;
  const healthy = count("fail") === 0;

  return {
    domain,
    healthy,
    summary:
      `${domain}: ${healthy ? "healthy" : "UNHEALTHY"} - ${count("ok")} ok, ${count("warn")} warning(s), ` +
      `${count("fail")} failing, ${count("skipped")} skipped.`,
    checks,
    next_steps: Object.values(steps).flat(),
  };
}
