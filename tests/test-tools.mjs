#!/usr/bin/env node
// Interactive, tool-by-tool test runner: brings up the Docker sandbox, then
// drives every registered MCP tool over the real stdio JSON-RPC protocol
// (the same way a real client would), reporting PASS/FAIL/SKIP per tool.
//
// Credentials and the domain to test under come from .env.test (see
// .env.test.example) - separate from .env, which only needs to exist for
// `docker compose up` to start the container. The runner injects
// .env.test's AWS credentials directly into each `docker compose exec`
// call, so .env and .env.test never need to match.
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parse as parseEnv } from "dotenv";
import {
  Route53Client,
  GetHostedZoneCommand,
  ListResourceRecordSetsCommand,
  ChangeResourceRecordSetsCommand,
} from "@aws-sdk/client-route-53";

const ENV_TEST_PATH = ".env.test";
const ENV_TEST_EXAMPLE = ".env.test.example";

// Canonical order for the final report - matches src/index.ts registration.
const ALL_TOOLS = [
  "list_sites", "get_site_config", "check_cert_expiry", "check_dns",
  "check_upstream_health", "get_nginx_status", "tail_site_logs", "list_archived_sites",
  "create_domain_record", "delete_domain_record", "create_txt_record",
  "create_site", "delete_site", "restore_site", "prune_archives",
  "reload_nginx",
  "issue_cert", "issue_wildcard_cert", "renew_cert", "revoke_cert", "delete_cert",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "", stderr = "";
    if (capture) {
      proc.stdout.on("data", (d) => (stdout += d));
      proc.stderr.on("data", (d) => (stderr += d));
    }
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr}`), { code }));
    });
  });
}

class McpClient {
  constructor(env) {
    const args = [
      // -u mcpuser: without this, `compose exec` defaults to the container's
      // CMD user (root, since systemd needs it as PID 1) - that would test
      // against root's own unrestricted sudo policy instead of mcpuser's
      // narrow, env_keep-scoped one, silently hiding real privilege-boundary
      // bugs (this is exactly how the AWS_DEFAULT_REGION env-passthrough
      // bug in issue_wildcard_cert stayed invisible until now).
      "compose", "exec", "-T", "-u", "mcpuser",
      "-e", `AWS_ACCESS_KEY_ID=${env.accessKeyId}`,
      "-e", `AWS_SECRET_ACCESS_KEY=${env.secretAccessKey}`,
      "-e", `ROUTE53_HOSTED_ZONE_ID=${env.hostedZoneId}`,
    ];
    // Optional - the tools default to us-east-1 themselves when unset, this
    // just lets .env.test override that if ever needed.
    if (env.awsDefaultRegion) args.push("-e", `AWS_DEFAULT_REGION=${env.awsDefaultRegion}`);
    args.push("sandbox", "node", "dist/index.js");
    this.proc = spawn("docker", args);
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.stderrBuf = "";
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => (this.stderrBuf += d.toString()));
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    }
  }

  _send(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timed out waiting for "${method}" (${timeoutMs}ms). Stderr: ${this.stderrBuf.slice(-500)}`));
        }
      }, timeoutMs);
    });
  }

  _notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize() {
    await this._send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-tools", version: "1.0" },
    });
    this._notify("notifications/initialized");
  }

  async callTool(name, args, timeoutMs) {
    // A timeout/transport error here is a rejected promise, not a JSON-RPC
    // error response - catch it too, so one slow/stuck tool call reports as
    // a single failure instead of crashing the whole run before the
    // remaining steps (and the summary table) get a chance to happen.
    let res;
    try {
      res = await this._send("tools/call", { name, arguments: args }, timeoutMs);
    } catch (err) {
      return { ok: false, detail: err.message };
    }
    if (res.error) return { ok: false, detail: res.error.message };
    if (res.result?.isError) {
      const text = res.result?.content?.map((c) => c.text).join(" ") ?? "tool reported an error";
      return { ok: false, detail: text };
    }
    const text = res.result?.content?.[0]?.text ?? "";
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { ok: true, parsed };
  }

  close() {
    try { this.proc.stdin.end(); } catch {}
    this.proc.kill();
  }
}

const results = new Map();
function report(tool, status, detail) {
  results.set(tool, { status, detail });
  const icon = status === "pass" ? "✓" : status === "fail" ? "✗" : "–";
  console.log(`  ${icon} ${tool}${detail ? " - " + detail : ""}`);
}

async function step(client, tool, args, predicate, timeoutMs) {
  const { ok, parsed, detail } = await client.callTool(tool, args, timeoutMs);
  if (!ok) { report(tool, "fail", detail); return { pass: false, parsed: null }; }
  const verdict = predicate ? predicate(parsed) : true;
  if (verdict === true || verdict == null) { report(tool, "pass"); return { pass: true, parsed }; }
  const reason = typeof verdict === "string" ? verdict : "unexpected result shape";
  const toolMessage = parsed && typeof parsed === "object" ? (parsed.message ?? parsed.certbot_output) : null;
  report(tool, "fail", toolMessage ? `${reason}: ${toolMessage}` : reason);
  return { pass: false, parsed };
}

async function cleanupTxtRecord(client, hostedZoneId, name) {
  try {
    const list = await client.send(new ListResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId, StartRecordName: name, StartRecordType: "TXT", MaxItems: 1,
    }));
    const record = list.ResourceRecordSets?.[0];
    if (record?.Name?.replace(/\.$/, "") === name && record.Type === "TXT") {
      await client.send(new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        ChangeBatch: { Changes: [{ Action: "DELETE", ResourceRecordSet: record }] },
      }));
      console.log(`  (cleaned up test TXT record ${name} directly via AWS SDK - no delete_txt_record tool exists yet)`);
    }
  } catch (err) {
    console.error(`  WARNING: could not clean up TXT record ${name}: ${err.message}`);
  }
}

async function main() {
  if (!existsSync(ENV_TEST_PATH)) {
    console.error(`Missing ${ENV_TEST_PATH} - copy ${ENV_TEST_EXAMPLE} to ${ENV_TEST_PATH} and fill it in.`);
    process.exit(1);
  }
  const env = parseEnv(readFileSync(ENV_TEST_PATH));
  const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey,
    ROUTE53_HOSTED_ZONE_ID: hostedZoneId, TEST_DOMAIN: testDomain,
    AWS_DEFAULT_REGION: awsDefaultRegion } = env;
  if (!accessKeyId || !secretAccessKey || !hostedZoneId || !testDomain) {
    console.error(`${ENV_TEST_PATH} is missing one of AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ROUTE53_HOSTED_ZONE_ID, TEST_DOMAIN.`);
    process.exit(1);
  }

  console.log("1. Verifying AWS credentials and that TEST_DOMAIN is in this hosted zone...");
  // us-east-1: Route 53 is global, but the SDK still requires a signing region.
  const route53 = new Route53Client({
    region: awsDefaultRegion || "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
  });
  let zoneApex;
  try {
    const zone = await route53.send(new GetHostedZoneCommand({ Id: hostedZoneId }));
    zoneApex = zone.HostedZone?.Name?.replace(/\.$/, "");
  } catch (err) {
    console.error(`   FAIL: AWS credentials or ROUTE53_HOSTED_ZONE_ID look invalid: ${err.message}`);
    process.exit(1);
  }
  if (!zoneApex || !(testDomain === zoneApex || testDomain.endsWith(`.${zoneApex}`))) {
    console.error(`   FAIL: TEST_DOMAIN "${testDomain}" is not "${zoneApex}" or a subdomain of it.`);
    process.exit(1);
  }
  console.log(`   OK - zone: ${zoneApex}, TEST_DOMAIN: ${testDomain}`);

  const label = `mcp-test-${randomBytes(4).toString("hex")}`;
  const testSub = `${label}.${testDomain}`;

  console.log(`\nWill run every MCP tool against the Docker sandbox, using "${testSub}" as a` +
    ` disposable subdomain. This creates and deletes real Route 53 records under "${zoneApex}".`);

  let includeCerts;
  // Piping input into a script that's running detached from a real TTY
  // (e.g. launched in the background) doesn't reliably reach a readline
  // prompt - rather than hang or silently no-op on EOF, treat a
  // non-interactive stdin as consent to proceed (you already had to run
  // this deliberately) and gate the slower cert scenario behind an
  // explicit --certs flag instead of a prompt.
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const proceed = (await rl.question("Continue? [y/N] ")).trim().toLowerCase();
    if (proceed !== "y" && proceed !== "yes") { rl.close(); process.exit(0); }
    const certAnswer = (await rl.question(
      "Also test certificate issuance (issue_wildcard_cert, renew_cert, revoke_cert, delete_cert)?\n" +
      "Hits real Let's Encrypt staging, adds ~1-2 min. [y/N] "
    )).trim().toLowerCase();
    includeCerts = certAnswer === "y" || certAnswer === "yes";
    rl.close();
  } else {
    includeCerts = process.argv.includes("--certs");
    console.log(`Non-interactive stdin - proceeding automatically. ` +
      `Certificate issuance tests: ${includeCerts ? "included (--certs)" : "skipped (pass --certs to include)"}.`);
  }

  if (!existsSync(".env")) {
    copyFileSync(".env.example", ".env");
    console.log("\nNo .env found - copied .env.example (blank values). docker compose only needs " +
      "the file to exist; real test credentials come from .env.test.");
  }

  console.log("\n2. Starting the Docker sandbox (docker compose up -d --build)...");
  await run("docker", ["compose", "up", "-d", "--build"]);

  console.log("\n3. Waiting for nginx to be active inside the container...");
  let nginxReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      await run("docker", ["compose", "exec", "-T", "sandbox", "systemctl", "is-active", "--quiet", "nginx"], { capture: true });
      nginxReady = true;
      break;
    } catch { await sleep(2000); }
  }
  if (!nginxReady) {
    console.error("   FAIL: nginx never became active in the sandbox - see `docker compose logs sandbox`.");
    process.exit(1);
  }
  console.log("   OK");

  const client = new McpClient({ accessKeyId, secretAccessKey, hostedZoneId, awsDefaultRegion });
  await client.initialize();

  try {
    console.log("\n4. Read-only diagnostics:");
    await step(client, "list_sites", {}, (p) => Array.isArray(p));
    await step(client, "check_cert_expiry", {}, (p) => Array.isArray(p));
    await step(client, "get_nginx_status", {}, (p) => typeof p?.running === "boolean" && typeof p?.version === "string");
    await step(client, "check_dns", { domain: testDomain }, (p) => p?.resolves === true || `did not resolve "${testDomain}" - does it really exist?`);
    await step(client, "check_upstream_health", { upstream_host: "127.0.0.1", upstream_port: 80 }, (p) => p?.reachable === true);
    await step(client, "list_archived_sites", {}, (p) => Array.isArray(p));

    console.log("\n5. Site lifecycle:");
    const created = await step(client, "create_site", { domain: testSub, upstream_host: "127.0.0.1", upstream_port: 3000 }, (p) => p?.success === true);
    if (created.pass) {
      await step(client, "get_site_config", { domain: testSub }, (p) => p?.domain === testSub && typeof p?.raw_config === "string");
      await step(client, "reload_nginx", {}, (p) => p?.success === true);
      await step(client, "tail_site_logs", { log_type: "access", lines: 5 }, (p) => p?.success === true);
      const deleted = await step(client, "delete_site", { domain: testSub, confirm: true }, (p) => p?.success === true);
      if (deleted.pass) {
        await step(client, "restore_site", { domain: testSub, confirm: true }, (p) => p?.success === true);
        // older_than_days must be >=1 (tool schema), so this won't actually
        // match the archive we just created - it's still a valid smoke
        // test of "does the tool run and respond correctly."
        await step(client, "prune_archives", { older_than_days: 1, confirm: true }, (p) => p?.success === true);
      } else {
        report("restore_site", "skip", "blocked by delete_site failure");
        report("prune_archives", "skip", "blocked by delete_site failure");
      }
    } else {
      for (const t of ["get_site_config", "reload_nginx", "tail_site_logs", "delete_site", "restore_site", "prune_archives"]) {
        report(t, "skip", "blocked by create_site failure");
      }
    }

    console.log("\n6. DNS (Route 53):");
    const dnsCreated = await step(client, "create_domain_record", { domain: testSub, target: testDomain, ttl: 60 }, (p) => p?.success === true);
    await step(client, "create_txt_record", { domain: `_acme-challenge.${testSub}`, value: "test-value" }, (p) => p?.success === true);
    if (dnsCreated.pass) {
      await step(client, "delete_domain_record", { domain: testSub, confirm: true }, (p) => p?.success === true);
    } else {
      report("delete_domain_record", "skip", "blocked by create_domain_record failure");
    }

    console.log("\n7. Certificates:");
    report("issue_cert", "skip", "needs public port-80 reachability, not available in the sandbox");
    if (includeCerts) {
      const issued = await step(client, "issue_wildcard_cert", { domain: testSub, staging: true }, (p) => p?.success === true, 180000);
      if (issued.pass) {
        // Same 180s budget as issue_wildcard_cert - a dry-run renewal still
        // does the full DNS-01 create/propagate/validate/cleanup dance.
        await step(client, "renew_cert", { domain: testSub, dry_run: true }, (p) => p?.success === true, 180000);
        await step(client, "revoke_cert", { domain: testSub, confirm: true }, (p) => p?.success === true);
        await step(client, "delete_cert", { domain: testSub, confirm: true }, (p) => p?.success === true);
      } else {
        for (const t of ["renew_cert", "revoke_cert", "delete_cert"]) report(t, "skip", "blocked by issue_wildcard_cert failure");
      }
    } else {
      for (const t of ["issue_wildcard_cert", "renew_cert", "revoke_cert", "delete_cert"]) report(t, "skip", "cert scenario declined");
    }
  } finally {
    console.log("\n8. Best-effort cleanup...");
    await client.callTool("delete_site", { domain: testSub, confirm: true }).catch(() => {});
    await client.callTool("delete_domain_record", { domain: testSub, confirm: true }).catch(() => {});
    if (includeCerts) await client.callTool("delete_cert", { domain: testSub, confirm: true }).catch(() => {});
    await cleanupTxtRecord(route53, hostedZoneId, `_acme-challenge.${testSub}`);
    client.close();
  }

  console.log("\n=== Results ===");
  let failures = 0;
  for (const tool of ALL_TOOLS) {
    const r = results.get(tool) ?? { status: "skip", detail: "not run" };
    const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "–";
    if (r.status === "fail") failures++;
    console.log(`${icon} ${tool}${r.detail ? " - " + r.detail : ""}`);
  }
  console.log(`\n${failures === 0 ? "All tested tools passed." : `${failures} tool(s) failed.`} ` +
    "Sandbox is still running - `docker compose down` when you're done.");
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`\nFAIL: ${err.stack ?? err}`);
  process.exitCode = 1;
});
