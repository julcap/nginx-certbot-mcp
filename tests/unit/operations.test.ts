import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  InMemoryOperationHistory,
  classifyUpdateSiteResult,
  operationVisible,
  sanitizeOperationValue,
} from "../../src/operations.js";
import { loadPolicy } from "../../src/policy.js";
import { AuditLogger } from "../../src/audit.js";
import { createRegistrar } from "../../src/guard.js";
import { startServer, tempDir, textOf } from "./helpers.js";

function startUpdate(history: InMemoryOperationHistory, domain = "app.example.com") {
  return history.start({
    tool: "update_site",
    mutating: true,
    target: domain,
    args: { domain, upstream_port: 3000 },
    client: { displayName: "unit-test/0.0.0" },
  });
}

test("in-memory operation history keeps separate lifecycle states without claiming durability", () => {
  const history = new InMemoryOperationHistory();
  const started = startUpdate(history);
  assert.equal(started.executionStatus, "running");
  assert.equal(started.verificationStatus, "not_requested");

  const finished = history.finish(started.id, {
    executionStatus: "succeeded",
    verificationStatus: "pending",
    steps: [{ name: "write_config", status: "succeeded" }],
    evidence: [{ kind: "local_nginx_config_test", status: "passed", summary: "syntax valid" }],
    rollback: { status: "not_needed" },
  });
  assert.equal(finished.executionStatus, "succeeded");
  assert.equal(finished.verificationStatus, "pending");
  assert.ok(finished.finishedAt);
  assert.deepEqual(history.get(started.id), finished);

  // The first increment is intentionally process-local while durable SQLite
  // compatibility is unresolved. A fresh instance must not imply persistence.
  assert.deepEqual(new InMemoryOperationHistory().list().operations, []);
});

test("operation data is deeply redacted and bounded before entering history", () => {
  const history = new InMemoryOperationHistory();
  const started = history.start({
    tool: "update_site",
    mutating: true,
    target: "safe.example.com",
    args: {
      domain: "safe.example.com",
      nested: {
        apiToken: "do-not-store",
        label: "x".repeat(700),
        detail: "request failed: password=hunter2 and Authorization: Bearer abc.def",
      },
      values: Array.from({ length: 75 }, (_, i) => i),
      ["k".repeat(700)]: "bounded-key",
    },
  });
  const nested = started.args.nested as Record<string, unknown>;
  assert.equal(nested.apiToken, "[redacted]");
  assert.match(String(nested.label), /\[\+200 chars\]$/);
  assert.equal(String(nested.detail).includes("hunter2"), false);
  assert.equal(String(nested.detail).includes("abc.def"), false);
  assert.match(String(nested.detail), /password=\[redacted\].*Authorization: \*\*\*/i);
  assert.equal((started.args.values as unknown[]).length, 50);
  assert.equal(Math.max(...Object.keys(started.args).map((key) => key.length)), 500);

  const finished = history.finish(started.id, {
    executionStatus: "failed",
    verificationStatus: "unavailable",
    steps: Array.from({ length: 30 }, (_, i) => ({ name: `step-${i}`, status: "skipped" as const })),
    evidence: Array.from({ length: 30 }, (_, i) => ({ kind: `kind-${i}`, status: "unavailable" as const, summary: "z".repeat(700) })),
    errors: Array.from({ length: 30 }, (_, i) => ({ code: `E${i}`, message: "m".repeat(700) })),
  });
  assert.equal(finished.steps.length, 20);
  assert.equal(finished.evidence.length, 20);
  assert.equal(finished.errors.length, 20);
  assert.match(finished.errors[0].message, /…$/);
});

test("bounded in-memory history retains running operations and evicts oldest completed records", () => {
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  const history = new InMemoryOperationHistory({ maxRecords: 2, now: () => new Date(tick += 1000) });
  const running = startUpdate(history, "running.example.com");
  const old = startUpdate(history, "old.example.com");
  history.finish(old.id, { executionStatus: "succeeded", verificationStatus: "pending" });
  const newest = startUpdate(history, "new.example.com");

  assert.equal(history.get(running.id)?.executionStatus, "running");
  assert.equal(history.get(old.id), null);
  assert.equal(history.get(newest.id)?.executionStatus, "running");
  assert.throws(() => startUpdate(history, "overflow.example.com"), /capacity.*running/i);
});

test("list operations paginates with opaque cursors and applies policy visibility", () => {
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  const history = new InMemoryOperationHistory({ now: () => new Date(tick += 1000) });
  const visible = startUpdate(history, "a.example.com");
  history.finish(visible.id, { executionStatus: "succeeded", verificationStatus: "pending" });
  const hidden = startUpdate(history, "b.other.org");
  history.finish(hidden.id, { executionStatus: "failed", verificationStatus: "unavailable" });
  const secondVisible = startUpdate(history, "c.example.com");
  history.finish(secondVisible.id, { executionStatus: "denied", verificationStatus: "not_requested" });

  const policy = loadPolicy({ ALLOWED_DOMAINS: "*.example.com", MCP_ENABLED_TOOLS: "update_site,list_operations,get_operation" });
  const canSee = (record: Parameters<typeof operationVisible>[1]) => operationVisible(policy, record);
  const page = history.list({ pageSize: 1 }, canSee);
  assert.deepEqual(page.operations.map((record) => record.id), [secondVisible.id]);
  assert.match(page.nextCursor ?? "", /^[A-Za-z0-9_-]+$/);
  const second = history.list({ pageSize: 1, cursor: page.nextCursor }, canSee);
  assert.deepEqual(second.operations.map((record) => record.id), [visible.id]);
  assert.equal(second.nextCursor, undefined);
  assert.equal(history.get(hidden.id, canSee), null);
  assert.throws(() => history.list({ cursor: "not-a-valid-cursor" }), /Invalid operation cursor/);
  assert.throws(() => history.list({ cursor: "a".repeat(513) }), /Invalid operation cursor/);
});

test("operation visibility uses authoritative metadata and tool allowlists", () => {
  const history = new InMemoryOperationHistory();
  const record = startUpdate(history);
  assert.equal(operationVisible(loadPolicy({ MCP_MODE: "readonly" }), record), false);
  assert.equal(operationVisible(loadPolicy({ MCP_ENABLED_TOOLS: "list_operations,get_operation" }), record), false);
  assert.equal(operationVisible(loadPolicy({ MCP_ENABLED_TOOLS: "update_site" }), record), true);
  assert.equal(operationVisible(loadPolicy({ MCP_ENABLED_TOOLS: "update_site" }), { ...record, mutating: false }), false);
});

test("sanitizeOperationValue handles cycles", () => {
  const value: Record<string, unknown> = { name: "safe" };
  value.self = value;
  assert.deepEqual(sanitizeOperationValue(value), { name: "safe", self: "[circular]" });
});

test("update_site classification never confuses local execution with live verification", () => {
  const success = classifyUpdateSiteResult({
    success: true,
    test_output: "nginx: configuration file syntax is ok",
    reload_required: true,
    backup_created: true,
  });
  assert.equal(success.executionStatus, "succeeded");
  assert.equal(success.verificationStatus, "pending");
  assert.deepEqual(success.rollback, { status: "not_needed" });
  assert.match(success.evidence?.[1].summary ?? "", /reload.*not.*performed/i);

  const rolledBack = classifyUpdateSiteResult({
    success: false,
    test_output: "nginx: syntax error",
    reload_required: false,
    backup_created: true,
  });
  assert.equal(rolledBack.executionStatus, "failed");
  assert.equal(rolledBack.verificationStatus, "failed");
  assert.equal(rolledBack.rollback?.status, "succeeded");

  const unavailable = classifyUpdateSiteResult({
    success: false,
    test_output: "No existing config",
    reload_required: false,
  });
  assert.equal(unavailable.executionStatus, "failed");
  assert.equal(unavailable.verificationStatus, "unavailable");
});

test("registrar instruments update_site and correlates audit without changing its result", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const history = new InMemoryOperationHistory();
    const auditPath = path.join(dir, "audit.jsonl");
    const audit = new AuditLogger(auditPath);
    await audit.init();
    let wrapped: ((args: Record<string, unknown>) => Promise<any>) | undefined;
    const server = { registerTool(_name: string, _config: unknown, handler: typeof wrapped) { wrapped = handler; } };
    const { registerTool } = createRegistrar(server as any, {
      audit,
      history,
      policy: loadPolicy({}),
      getClient: () => "fake-client/1.0",
    });
    const expected = {
      content: [{ type: "text", text: "unchanged" }],
      structuredContent: { success: true, test_output: "syntax ok", reload_required: true, backup_created: true },
    };
    registerTool("update_site", { inputSchema: {}, annotations: { idempotentHint: true } }, async () => expected);

    assert.equal(await wrapped!({ domain: "app.example.com", upstream_port: 3000 }), expected);
    const [operation] = history.list().operations;
    assert.equal(operation.executionStatus, "succeeded");
    assert.equal(operation.verificationStatus, "pending");
    assert.deepEqual(operation.client, { displayName: "fake-client/1.0", identityTrusted: false });
    const [auditEntry] = (await readFile(auditPath, "utf-8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(auditEntry.operation_id, operation.id);
  } finally {
    await cleanup();
  }
});

test("history failures do not suppress policy, audit, or update_site results", async () => {
  const { dir, cleanup } = await tempDir();
  const originalConsoleError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const auditPath = path.join(dir, "audit.jsonl");
    const audit = new AuditLogger(auditPath);
    await audit.init();
    let wrapped: ((args: Record<string, unknown>) => Promise<any>) | undefined;
    let calls = 0;
    const expected = { content: [{ type: "text", text: "unchanged" }], structuredContent: { success: true, test_output: "syntax ok", reload_required: true } };
    const server = { registerTool(_name: string, _config: unknown, handler: typeof wrapped) { wrapped = handler; } };
    const failingHistory = { start() { throw new Error("history unavailable"); } };
    const { registerTool } = createRegistrar(server as any, {
      audit,
      history: failingHistory as any,
      policy: loadPolicy({ ALLOWED_DOMAINS: "*.example.com" }),
    });
    registerTool("update_site", { inputSchema: {}, annotations: {} }, async (): Promise<any> => {
      calls += 1;
      return expected;
    });

    assert.equal(await wrapped!({ domain: "app.example.com" }), expected);
    assert.equal((await wrapped!({ domain: "app.other.org" })).isError, true);
    assert.equal(calls, 1);
    const auditEntries = (await readFile(auditPath, "utf-8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(auditEntries.map((entry) => entry.outcome), ["ok", "denied"]);
    assert.equal(errors.filter((line) => line.includes("[operations] failed to start update_site")).length, 2);
  } finally {
    console.error = originalConsoleError;
    await cleanup();
  }
});

test("MCP stdio exposes current-process list/get for an isolated failed update_site workflow", async () => {
  const { dir, cleanup } = await tempDir();
  const client = await startServer({
    AUDIT_LOG_PATH: path.join(dir, "audit.jsonl"),
    MCP_ENABLED_TOOLS: "update_site,list_operations,get_operation",
  });
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["get_operation", "list_operations", "update_site"]);
    const listSchema = tools.find((tool) => tool.name === "list_operations")?.inputSchema as any;
    assert.equal(listSchema.properties.cursor.maxLength, 512);

    const update = await client.callTool({
      name: "update_site",
      arguments: { domain: "not a domain", upstream_host: "127.0.0.1", upstream_port: 3000 },
    });
    assert.equal(update.isError, true);
    assert.match(textOf(update), /Invalid domain/);

    const listed = await client.callTool({ name: "list_operations", arguments: { page_size: 10, tool: "update_site" } });
    assert.notEqual(listed.isError, true);
    const listPayload = JSON.parse(textOf(listed));
    assert.equal(listPayload.operations.length, 1);
    assert.equal(listPayload.operations[0].executionStatus, "failed");
    assert.equal(listPayload.operations[0].verificationStatus, "unavailable");

    const detail = await client.callTool({ name: "get_operation", arguments: { id: listPayload.operations[0].id } });
    const detailPayload = JSON.parse(textOf(detail));
    assert.equal(detailPayload.operation.id, listPayload.operations[0].id);
    assert.equal(detailPayload.operation.client.identityTrusted, false);
  } finally {
    await client.close();
    await cleanup();
  }
});