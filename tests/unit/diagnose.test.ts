import { test } from "node:test";
import assert from "node:assert/strict";
import { certCoversDomain, parseCertbotOutput } from "../../src/tools/checkCertExpiry.js";
import { parseSiteConfig } from "../../src/tools/listSites.js";
import { diagnoseSite, parseUpstream, type DiagnoseDeps } from "../../src/tools/diagnoseSite.js";
import { startServer, tempDir, textOf } from "./helpers.js";

const D = "app.example.com";

const HTTP_CONFIG = `server {
  listen 80;
  server_name ${D};
  location / { proxy_pass http://10.0.0.5:3000; }
}`;
const HTTPS_CONFIG = `server {
  listen 443 ssl;
  server_name ${D};
  ssl_certificate /etc/letsencrypt/live/${D}/fullchain.pem;
  location / { proxy_pass http://10.0.0.5:3000; }
}`;

const cert = (days: number, ...domains: string[]) => ({
  domain: domains[0], domains, expires_at: "2027-01-01 00:00:00+00:00", days_remaining: days, auto_renew_enabled: true,
});

// A healthy HTTPS site; each test overrides only what it wants to break.
function deps(over: Partial<DiagnoseDeps> = {}): DiagnoseDeps {
  return {
    readConfig: async () => HTTPS_CONFIG,
    isEnabled: async () => true,
    nginxStatus: async () => ({ running: true, version: "nginx version: nginx/1.24.0" }),
    nginxConfigTest: async () => ({ ok: true, output: "ok" }),
    resolve: async () => ({ resolves: true, record_type: "A", values: ["203.0.113.7"] }),
    probeUpstream: async () => ({ reachable: true, message: "TCP connect succeeded." }),
    certificates: async () => [cert(60, D)],
    errorLog: async () => [],
    ...over,
  };
}

test("parseUpstream handles ports, https defaults, paths, and things it can't probe", () => {
  assert.deepEqual(parseUpstream("http://10.0.0.5:3000"), { host: "10.0.0.5", port: 3000 });
  assert.deepEqual(parseUpstream("http://svc.internal"), { host: "svc.internal", port: 80 });
  assert.deepEqual(parseUpstream("https://svc.internal/api"), { host: "svc.internal", port: 443 });
  assert.equal(parseUpstream("http://unix:/run/app.sock"), null);
  assert.equal(parseUpstream("http://$backend"), null);
  assert.equal(parseUpstream("backend_pool"), null);
  assert.equal(parseUpstream(null), null);
});

test("parseSiteConfig extracts name, upstream and SSL", () => {
  assert.deepEqual(parseSiteConfig(HTTPS_CONFIG), { server_name: D, upstream: "http://10.0.0.5:3000", ssl_enabled: true });
  assert.equal(parseSiteConfig(HTTP_CONFIG).ssl_enabled, false);
});

test("certbot output exposes every name; wildcards cover exactly one label", () => {
  const out = `Found the following certs:
  Certificate Name: example.com
    Domains: example.com *.example.com
    Expiry Date: 2027-01-01 00:00:00+00:00 (VALID: 60 days)
`;
  const [c] = parseCertbotOutput(out);
  assert.deepEqual({ domain: c.domain, domains: c.domains }, { domain: "example.com", domains: ["example.com", "*.example.com"] });
  assert.equal(certCoversDomain(c.domains, "a.example.com"), true);
  assert.equal(certCoversDomain(c.domains, "example.com"), true);
  assert.equal(certCoversDomain(c.domains, "a.b.example.com"), false);
  assert.equal(certCoversDomain(["*.example.com"], "example.com"), false);
  assert.equal(certCoversDomain(["a.example.com"], "b.example.com"), false);
});

test("a healthy site has no failures and no next steps", async () => {
  const r = await diagnoseSite(D, deps());
  assert.equal(r.healthy, true);
  assert.deepEqual(Object.values(r.checks).map((c) => c.status), ["ok", "ok", "ok", "ok", "ok", "ok"]);
  assert.deepEqual(r.next_steps, []);
  assert.match(r.summary, /healthy - 6 ok, 0 warning\(s\), 0 failing/);
  assert.equal(r.checks.certificate.days_remaining, 60);
});

test("no config: fails, points at create_site, and skips the upstream probe", async () => {
  let probed = false;
  const r = await diagnoseSite(D, deps({
    readConfig: async () => null,
    probeUpstream: async () => { probed = true; return { reachable: true, message: "" }; },
    certificates: async () => [],
  }));
  assert.equal(r.healthy, false);
  assert.equal(r.checks.config.status, "fail");
  assert.equal(r.checks.upstream.status, "skipped");
  assert.equal(probed, false);
  assert.match(r.next_steps[0], /create_site/);
});

test("config present but not enabled", async () => {
  const r = await diagnoseSite(D, deps({ isEnabled: async () => false }));
  assert.equal(r.checks.config.status, "fail");
  assert.equal(r.checks.config.enabled, false);
  assert.match(r.next_steps.join("\n"), /re-enable/);
});

test("nginx down / failing config test", async () => {
  const down = await diagnoseSite(D, deps({ nginxStatus: async () => ({ running: false, version: "1.24" }) }));
  assert.equal(down.checks.nginx.status, "fail");
  assert.equal(down.checks.nginx.running, false);

  const broken = await diagnoseSite(D, deps({ nginxConfigTest: async () => ({ ok: false, output: "[emerg] bad directive" }) }));
  assert.equal(broken.checks.nginx.status, "fail");
  assert.match(broken.checks.nginx.detail, /bad directive/);
  assert.match(broken.next_steps.join("\n"), /rollback_site/);
});

test("DNS not resolving and upstream unreachable", async () => {
  const r = await diagnoseSite(D, deps({
    resolve: async () => ({ resolves: false }),
    probeUpstream: async () => ({ reachable: false, message: "connection refused" }),
  }));
  assert.equal(r.healthy, false);
  assert.equal(r.checks.dns.status, "fail");
  assert.equal(r.checks.upstream.status, "fail");
  assert.equal(r.checks.upstream.detail, "connection refused");
  assert.match(r.next_steps.join("\n"), /create_domain_record/);
  assert.match(r.next_steps.join("\n"), /10\.0\.0\.5:3000/);
});

test("certificate states: missing, missing-but-HTTPS, expired, expiring, unused, wildcard", async () => {
  const httpOnly = await diagnoseSite(D, deps({ readConfig: async () => HTTP_CONFIG, certificates: async () => [] }));
  assert.equal(httpOnly.checks.certificate.status, "warn");
  assert.equal(httpOnly.healthy, true, "HTTP-only is a warning, not a failure");
  assert.match(httpOnly.next_steps.join("\n"), /issue_cert/);

  const missing = await diagnoseSite(D, deps({ certificates: async () => [] }));
  assert.equal(missing.checks.certificate.status, "fail");

  const expired = await diagnoseSite(D, deps({ certificates: async () => [cert(-3, D)] }));
  assert.equal(expired.checks.certificate.status, "fail");
  assert.match(expired.checks.certificate.detail, /expired 3 day/);

  const soon = await diagnoseSite(D, deps({ certificates: async () => [cert(9, D)] }));
  assert.equal(soon.checks.certificate.status, "warn");
  assert.equal(soon.healthy, true);
  assert.match(soon.next_steps.join("\n"), /renew_cert/);

  const unused = await diagnoseSite(D, deps({ readConfig: async () => HTTP_CONFIG, certificates: async () => [cert(60, D)] }));
  assert.equal(unused.checks.certificate.status, "warn");
  assert.match(unused.checks.certificate.detail, /doesn't use it/);

  const wildcard = await diagnoseSite(D, deps({ certificates: async () => [cert(60, "example.com", "*.example.com")] }));
  assert.equal(wildcard.checks.certificate.status, "ok");
  assert.equal(wildcard.checks.certificate.cert_name, "example.com");
});

test("error log: keeps only lines for this site or its upstream, latest 10", async () => {
  const noise = Array.from({ length: 30 }, (_, i) => `[error] unrelated ${i} server: other.org`);
  const mine = Array.from({ length: 12 }, (_, i) => `[error] ${i} upstream: "http://10.0.0.5:3000/x" server: ${D}`);
  const r = await diagnoseSite(D, deps({ errorLog: async () => [...noise, ...mine, "[error] connect() to 10.0.0.5:3000 failed"] }));
  assert.equal(r.checks.recent_errors.status, "warn");
  assert.equal(r.checks.recent_errors.lines.length, 10);
  assert.match(r.checks.recent_errors.lines.at(-1)!, /connect\(\) to 10\.0\.0\.5:3000 failed/);
  assert.ok(r.checks.recent_errors.lines.every((l) => l.includes(D) || l.includes("10.0.0.5:3000")));
  assert.match(r.checks.recent_errors.detail, /13 error-log line/);
});

test("a check that throws is skipped with the reason; the rest still run", async () => {
  const r = await diagnoseSite(D, deps({
    certificates: async () => { throw new Error("sudo: a password is required"); },
    errorLog: async () => { throw new Error("log unreadable"); },
  }));
  assert.equal(r.checks.certificate.status, "skipped");
  assert.match(r.checks.certificate.detail, /a password is required/);
  assert.equal(r.checks.recent_errors.status, "skipped");
  assert.deepEqual(r.checks.recent_errors.lines, []);
  assert.equal(r.checks.dns.status, "ok");
  assert.equal(r.healthy, true, "skipped checks don't fail the diagnosis");
});

test("next_steps come out in a fixed order regardless of which check finishes first", async () => {
  const slow = <T>(v: T, ms: number) => new Promise<T>((res) => setTimeout(() => res(v), ms));
  const r = await diagnoseSite(D, deps({
    resolve: () => slow({ resolves: false }, 30),
    probeUpstream: () => slow({ reachable: false, message: "refused" }, 0),
  }));
  const dnsAt = r.next_steps.findIndex((s) => /create_domain_record/.test(s));
  const upstreamAt = r.next_steps.findIndex((s) => /unreachable/.test(s));
  assert.ok(dnsAt >= 0 && upstreamAt > dnsAt, "DNS advice precedes upstream advice");
});

test("rejects an invalid domain", async () => {
  await assert.rejects(diagnoseSite("not a domain", deps()), /Invalid domain/);
});

test("registered as a read-only tool; the domain allowlist applies to it", async () => {
  const { dir, cleanup } = await tempDir();
  const client = await startServer({ ALLOWED_DOMAINS: "*.example.com", MCP_MODE: "readonly", AUDIT_LOG_PATH: `${dir}/a.jsonl` });
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "diagnose_site");
    assert.ok(tool, "available even in readonly mode");
    assert.equal(tool.annotations?.readOnlyHint, true);
    const denied = await client.callTool({ name: "diagnose_site", arguments: { domain: "app.other.org" } });
    assert.match(textOf(denied), /Denied by policy/);
  } finally {
    await client.close();
    await cleanup();
  }
});
