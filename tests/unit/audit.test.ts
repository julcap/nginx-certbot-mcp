import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuditLogger, DEFAULT_AUDIT_PATH, redactArgs, resolveAuditPath, truncate } from "../../src/audit.js";
import { startServer, tempDir, textOf } from "./helpers.js";

test("resolveAuditPath: default, custom, and off", () => {
  assert.equal(resolveAuditPath({}), DEFAULT_AUDIT_PATH);
  assert.equal(resolveAuditPath({ AUDIT_LOG_PATH: "  " }), DEFAULT_AUDIT_PATH);
  assert.equal(resolveAuditPath({ AUDIT_LOG_PATH: "/var/log/mcp.jsonl" }), "/var/log/mcp.jsonl");
  assert.equal(resolveAuditPath({ AUDIT_LOG_PATH: "OFF" }), null);
});

test("redactArgs hides credentials and truncates long strings", () => {
  const out = redactArgs({
    domain: "a.example.com",
    aws_secret_access_key: "hunter2",
    api_token: "t",
    value: "x".repeat(600),
  });
  assert.equal(out.domain, "a.example.com");
  assert.equal(out.aws_secret_access_key, "[redacted]");
  assert.equal(out.api_token, "[redacted]");
  assert.match(String(out.value), /^x{500}… \[\+100 chars\]$/);
});

test("truncate collapses whitespace and caps length", () => {
  assert.equal(truncate("a\n  b\t c"), "a b c");
  assert.equal(truncate("y".repeat(400), 10), "yyyyyyyyyy…");
});

test("AuditLogger writes 0600 JSONL and init fails on an unwritable path", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const file = path.join(dir, "nested", "audit.jsonl");
    const logger = new AuditLogger(file);
    await logger.init();
    await logger.record({
      ts: "2026-01-01T00:00:00.000Z", tool: "t", mutating: true, args: {}, outcome: "ok", duration_ms: 1,
    });
    const lines = (await readFile(file, "utf-8")).trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).tool, "t");
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    // A path *under a regular file* can't be created on any OS or user (root included).
    // Not /proc/...: recursive mkdir there hangs on Linux instead of failing.
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "");
    await assert.rejects(new AuditLogger(path.join(blocker, "audit.jsonl")).init(), /Cannot write audit log/);
    await new AuditLogger(null).init(); // disabled: no-op
  } finally {
    await cleanup();
  }
});

test("server audits mutating calls (incl. dry runs) and only logs reads when asked", async () => {
  const { dir, cleanup } = await tempDir();
  const file = path.join(dir, "audit.jsonl");
  const client = await startServer({ AUDIT_LOG_PATH: file });
  try {
    // Dry run: returns before touching sudo, so it is safe to run anywhere.
    const dry = await client.callTool({ name: "delete_site", arguments: { domain: "audit.example.com", confirm: false } });
    assert.match(textOf(dry), /confirm:true/);
    // Validation error on a read-only tool: not logged by default.
    await client.callTool({ name: "check_dns", arguments: { domain: "not a domain" } });

    const entries = (await readFile(file, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(entries.length, 1);
    assert.deepEqual(
      { tool: entries[0].tool, mutating: entries[0].mutating, dry_run: entries[0].dry_run, outcome: entries[0].outcome },
      { tool: "delete_site", mutating: true, dry_run: true, outcome: "failed" }
    );
    assert.equal(entries[0].args.domain, "audit.example.com");
    assert.equal(entries[0].client, "unit-test/0.0.0");
  } finally {
    await client.close();
    await cleanup();
  }

  const second = await tempDir();
  const file2 = path.join(second.dir, "audit.jsonl");
  const client2 = await startServer({ AUDIT_LOG_PATH: file2, AUDIT_LOG_READS: "true" });
  try {
    await client2.callTool({ name: "check_dns", arguments: { domain: "not a domain" } });
    const [entry] = (await readFile(file2, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(entry.tool, "check_dns");
    assert.equal(entry.mutating, false);
    assert.equal(entry.outcome, "error");
    assert.match(entry.message, /Invalid domain/);
  } finally {
    await client2.close();
    await second.cleanup();
  }
});

test("server refuses to start when the audit log is unwritable", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await writeFile(path.join(dir, "blocker"), "");
    await assert.rejects(startServer({ AUDIT_LOG_PATH: path.join(dir, "blocker", "audit.jsonl") }));
  } finally {
    await cleanup();
  }
});
