import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDomainArgs, domainFilter, isDomainAllowed, isToolEnabled, loadPolicy, unmatchedPatterns } from "../../src/policy.js";
import { readFile } from "node:fs/promises";
import { startServer, tempDir, textOf, toolNames } from "./helpers.js";

test("loadPolicy defaults to readwrite with no allowlist", () => {
  assert.deepEqual(loadPolicy({}), { mode: "readwrite", enabledTools: null, allowedDomains: null });
});

test("loadPolicy rejects bad values instead of silently ignoring them", () => {
  assert.throws(() => loadPolicy({ MCP_MODE: "read-only" }), /Invalid MCP_MODE/);
  assert.throws(() => loadPolicy({ MCP_ENABLED_TOOLS: "list_sites, rm -rf" }), /Invalid MCP_ENABLED_TOOLS/);
});

test("isToolEnabled: readonly mode drops mutating tools", () => {
  const policy = loadPolicy({ MCP_MODE: "readonly" });
  assert.equal(isToolEnabled(policy, "list_sites", true), true);
  assert.equal(isToolEnabled(policy, "create_site", false), false);
});

test("isToolEnabled: allowlist supports * globs and intersects with the mode", () => {
  const policy = loadPolicy({ MCP_ENABLED_TOOLS: "check_*, list_sites, create_site" });
  assert.equal(isToolEnabled(policy, "check_dns", true), true);
  assert.equal(isToolEnabled(policy, "list_sites", true), true);
  assert.equal(isToolEnabled(policy, "get_site_config", true), false);
  assert.equal(isToolEnabled(policy, "create_site", false), true);

  const both = loadPolicy({ MCP_MODE: "readonly", MCP_ENABLED_TOOLS: "check_*, create_site" });
  assert.equal(isToolEnabled(both, "create_site", false), false, "readonly wins over the allowlist");
  assert.equal(isToolEnabled(both, "check_dns", true), true);
});

test("a glob only matches whole names and treats other characters literally", () => {
  const policy = loadPolicy({ MCP_ENABLED_TOOLS: "list_*" });
  assert.equal(isToolEnabled(policy, "list_sites", true), true);
  assert.equal(isToolEnabled(policy, "delist_sites", true), false);
});

test("unmatchedPatterns flags typos", () => {
  const policy = loadPolicy({ MCP_ENABLED_TOOLS: "list_sites,lst_sites,check_*" });
  assert.deepEqual(unmatchedPatterns(policy, ["list_sites", "check_dns"]), ["lst_sites"]);
});

test("server in readonly mode exposes only read-only tools", async () => {
  const { dir, cleanup } = await tempDir();
  const client = await startServer({ MCP_MODE: "readonly", AUDIT_LOG_PATH: `${dir}/a.jsonl` });
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), "every listed tool is read-only");
    const names = toolNames({ tools });
    assert.ok(names.includes("list_sites") && !names.includes("create_site") && !names.includes("reload_nginx"));
    assert.ok(names.includes("list_site_backups") && !names.includes("rollback_site"));

    // A mutating tool that isn't registered can't be called at all.
    const result = await client.callTool({ name: "delete_site", arguments: { domain: "a.example.com", confirm: true } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /not found/i);
  } finally {
    await client.close();
    await cleanup();
  }
});

test("server honours MCP_ENABLED_TOOLS", async () => {
  const { dir, cleanup } = await tempDir();
  const client = await startServer({ MCP_ENABLED_TOOLS: "check_*,list_sites", AUDIT_LOG_PATH: `${dir}/a.jsonl` });
  try {
    assert.deepEqual(toolNames(await client.listTools()), [
      "check_cert_expiry", "check_dns", "check_upstream_health", "list_sites",
    ]);
  } finally {
    await client.close();
    await cleanup();
  }
});

test("server refuses to start with an invalid MCP_MODE", async () => {
  await assert.rejects(startServer({ MCP_MODE: "yolo" }));
});

// --- ALLOWED_DOMAINS ---

test("loadPolicy validates ALLOWED_DOMAINS entries", () => {
  assert.deepEqual(loadPolicy({ ALLOWED_DOMAINS: " Example.com, *.Lab.Example.com. " }).allowedDomains, [
    "example.com",
    "*.lab.example.com",
  ]);
  for (const bad of ["*", "*.com", "com", "exa mple.com", "http://example.com", "example.com/x"]) {
    assert.throws(() => loadPolicy({ ALLOWED_DOMAINS: bad }), /Invalid ALLOWED_DOMAINS/, bad);
  }
});

test("isDomainAllowed: exact vs *. patterns", () => {
  const policy = loadPolicy({ ALLOWED_DOMAINS: "example.com,*.lab.net" });
  assert.equal(isDomainAllowed(policy, "example.com"), true);
  assert.equal(isDomainAllowed(policy, "EXAMPLE.com."), true);
  assert.equal(isDomainAllowed(policy, "www.example.com"), false, "exact entry does not cover subdomains");
  assert.equal(isDomainAllowed(policy, "a.lab.net"), true);
  assert.equal(isDomainAllowed(policy, "a.b.lab.net"), true, "wildcard covers any depth");
  assert.equal(isDomainAllowed(policy, "lab.net"), false, "wildcard does not cover the apex");
  assert.equal(isDomainAllowed(policy, "evillab.net"), false, "must match on a label boundary");
  assert.equal(isDomainAllowed(policy, "a.lab.net.evil.com"), false);
  assert.equal(isDomainAllowed(loadPolicy({}), "anything.io"), true, "no allowlist = allow all");
  assert.equal(domainFilter(policy)("x.lab.net"), true);
});

test("checkDomainArgs: unscoped calls, wildcard certs and TXT names", () => {
  const policy = loadPolicy({ ALLOWED_DOMAINS: "example.com,*.example.com" });
  assert.equal(checkDomainArgs(policy, "create_site", { domain: "a.example.com" }), null);
  assert.match(checkDomainArgs(policy, "create_site", { domain: "a.other.com" })!, /not permitted/);
  assert.equal(checkDomainArgs(policy, "create_txt_record", { domain: "_acme-challenge.a.example.com" }), null);
  assert.equal(checkDomainArgs(policy, "issue_wildcard_cert", { domain: "example.com" }), null);
  assert.match(checkDomainArgs(policy, "renew_cert", {})!, /needs an explicit domain/);
  assert.match(checkDomainArgs(policy, "tail_site_logs", { log_type: "access" })!, /needs an explicit domain/);
  assert.equal(checkDomainArgs(policy, "list_sites", {}), null, "listings are filtered instead");

  const apexOnly = loadPolicy({ ALLOWED_DOMAINS: "example.com" });
  assert.match(checkDomainArgs(apexOnly, "issue_wildcard_cert", { domain: "example.com" })!, /\*\.example\.com/);
  assert.equal(checkDomainArgs(loadPolicy({}), "renew_cert", {}), null);
});

test("server denies out-of-scope domains, audits the denial, and allows in-scope ones", async () => {
  const { dir, cleanup } = await tempDir();
  const file = `${dir}/a.jsonl`;
  const client = await startServer({ ALLOWED_DOMAINS: "*.example.com", AUDIT_LOG_PATH: file });
  try {
    const denied = await client.callTool({ name: "delete_site", arguments: { domain: "victim.other.org", confirm: true } });
    assert.equal(denied.isError, true);
    assert.match(textOf(denied), /Denied by policy.*victim\.other\.org/);

    // Read-only tools are subject to the same check.
    const read = await client.callTool({ name: "get_site_config", arguments: { domain: "victim.other.org" } });
    assert.match(textOf(read), /Denied by policy/);

    const renew = await client.callTool({ name: "renew_cert", arguments: { dry_run: true } });
    assert.match(textOf(renew), /needs an explicit domain/);

    // In scope: an unconfirmed delete is a harmless dry run, so it gets through.
    const ok = await client.callTool({ name: "delete_site", arguments: { domain: "a.example.com", confirm: false } });
    assert.notEqual(ok.isError, true);
    assert.match(textOf(ok), /confirm:true/);

    const entries = (await readFile(file, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(entries.map((e) => [e.tool, e.outcome]), [
      ["delete_site", "denied"],
      ["get_site_config", "denied"], // denials are logged even for read-only tools
      ["renew_cert", "denied"],
      ["delete_site", "failed"],
    ]);
  } finally {
    await client.close();
    await cleanup();
  }
});

test("server refuses to start with an invalid ALLOWED_DOMAINS", async () => {
  await assert.rejects(startServer({ ALLOWED_DOMAINS: "*.com" }));
});
