import { test } from "node:test";
import assert from "node:assert/strict";
import { isToolEnabled, loadPolicy, unmatchedPatterns } from "../../src/policy.js";
import { startServer, tempDir, textOf, toolNames } from "./helpers.js";

test("loadPolicy defaults to readwrite with no allowlist", () => {
  assert.deepEqual(loadPolicy({}), { mode: "readwrite", enabledTools: null });
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
