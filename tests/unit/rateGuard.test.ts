import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  checkBeforeIssuing,
  evaluateIssuance,
  looksLikeValidationFailure,
  recordIssuance,
  registeredDomain,
  stateFilePath,
  type IssuanceRecord,
} from "../../src/rateGuard.js";
import { tempDir } from "./helpers.js";

const NOW = Date.parse("2026-09-19T12:00:00Z");
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const ok = (ago: number, ...identifiers: string[]): IssuanceRecord => ({ ts: NOW - ago, identifiers, ok: true });
const failed = (ago: number, ...identifiers: string[]): IssuanceRecord => ({ ts: NOW - ago, identifiers, ok: false });

test("registeredDomain groups by last two labels, or three under a co.uk-style suffix", () => {
  assert.equal(registeredDomain("a.b.example.com"), "example.com");
  assert.equal(registeredDomain("*.example.com"), "example.com");
  assert.equal(registeredDomain("www.example.co.uk"), "example.co.uk");
  assert.equal(registeredDomain("example.com"), "example.com");
});

test("nothing recorded: allowed, no note", () => {
  assert.deepEqual(evaluateIssuance([], ["a.example.com"], NOW), { blocked: false });
});

test("duplicate limit: warns on the 4th, blocks on the 6th, and says when to retry", () => {
  const four = [1, 2, 3, 4].map((d) => ok(d * DAY, "a.example.com"));
  const warn = evaluateIssuance(four, ["a.example.com"], NOW);
  assert.equal(warn.blocked, false);
  assert.match(warn.note!, /last duplicate certificate/);

  const five = [...four, ok(5 * DAY, "a.example.com")];
  const verdict = evaluateIssuance(five, ["a.example.com"], NOW);
  assert.equal(verdict.blocked, true);
  // Oldest (5 days ago) leaves the 7-day window in 2 days.
  assert.match(verdict.note!, new RegExp(new Date(NOW + 2 * DAY).toISOString().replace(/[.]/g, "\\.")));
  assert.match(verdict.note!, /staging:true/);
});

test("duplicates only count the same exact names, successes, and the last 7 days", () => {
  const records = [
    ...[1, 2, 3, 4, 5].map((d) => ok(d * DAY, "other.example.com")),
    ...[8, 9, 10, 11, 12].map((d) => ok(d * DAY, "a.example.com")), // too old
    failed(HOUR, "a.example.com"),
    ok(DAY, "a.example.com", "*.a.example.com"), // different set
  ];
  assert.equal(evaluateIssuance(records, ["a.example.com"], NOW).blocked, false);
});

test("identifier order and case don't matter for the duplicate set", () => {
  const records = [1, 2, 3, 4, 5].map((d) => ok(d * DAY, "*.example.com", "example.com"));
  assert.equal(evaluateIssuance(records, ["Example.com", "*.example.com"], NOW).blocked, true);
});

test("failed-validation limit is per hour and per name", () => {
  const recentFails = [5, 10, 15, 20, 25].map((m) => failed(m * 60e3, "a.example.com"));
  const blocked = evaluateIssuance(recentFails, ["a.example.com"], NOW);
  assert.equal(blocked.blocked, true);
  assert.match(blocked.note!, /failed validations/);

  assert.equal(evaluateIssuance(recentFails, ["b.example.com"], NOW).blocked, false, "different name");
  const stale = [2, 3, 4, 5, 6].map((h) => failed(h * HOUR, "a.example.com"));
  assert.equal(evaluateIssuance(stale, ["a.example.com"], NOW).blocked, false, "older than an hour");
  assert.match(evaluateIssuance(recentFails.slice(0, 3), ["a.example.com"], NOW).note!, /3 failed validations/);
});

test("registered-domain limit counts sibling names and blocks at 50", () => {
  const siblings = (n: number) => Array.from({ length: n }, (_, i) => ok((i % 6) * DAY, `host${i}.example.com`));
  assert.equal(evaluateIssuance(siblings(44), ["new.example.com"], NOW).note, undefined);
  assert.match(evaluateIssuance(siblings(45), ["new.example.com"], NOW).note!, /45 certificates/);
  assert.equal(evaluateIssuance(siblings(50), ["new.example.com"], NOW).blocked, true);
  assert.equal(evaluateIssuance(siblings(50), ["new.other.org"], NOW).blocked, false);
});

test("looksLikeValidationFailure separates ACME failures from local ones", () => {
  assert.equal(looksLikeValidationFailure("Some challenges have failed."), true);
  assert.equal(looksLikeValidationFailure("Detail: ... urn:ietf:params:acme:error:unauthorized"), true);
  assert.equal(looksLikeValidationFailure("sudo: a password is required"), false);
});

test("state: records persist (0600), staging and 'off' are never counted or blocked", async () => {
  const { dir, cleanup } = await tempDir();
  const env = { MCP_STATE_DIR: dir };
  try {
    assert.equal(stateFilePath(env), path.join(dir, "issuance.json"));

    await recordIssuance(["a.example.com"], true, true, env, NOW); // staging
    await assert.rejects(stat(stateFilePath(env)), "staging attempts leave no history");

    for (let i = 0; i < 5; i++) await recordIssuance(["a.example.com"], false, true, env, NOW - i * DAY);
    const saved = JSON.parse(await readFile(stateFilePath(env), "utf-8"));
    assert.equal(saved.records.length, 5);
    assert.equal((await stat(stateFilePath(env))).mode & 0o777, 0o600);

    assert.equal((await checkBeforeIssuing(["a.example.com"], false, env, NOW)).blocked, true);
    assert.equal((await checkBeforeIssuing(["a.example.com"], true, env, NOW)).blocked, false, "staging exempt");
    assert.equal((await checkBeforeIssuing(["a.example.com"], false, { ...env, RATE_LIMIT_GUARD: "off" }, NOW)).blocked, false);
    assert.equal((await checkBeforeIssuing(["b.example.com"], false, env, NOW)).blocked, false);
  } finally {
    await cleanup();
  }
});

test("state: old records are pruned, concurrent writes don't lose entries, corrupt files reset", async () => {
  const { dir, cleanup } = await tempDir();
  const env = { MCP_STATE_DIR: dir };
  try {
    await recordIssuance(["old.example.com"], false, true, env, NOW - 30 * DAY);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => recordIssuance([`h${i}.example.com`], false, true, env, NOW))
    );
    const saved = JSON.parse(await readFile(stateFilePath(env), "utf-8"));
    assert.equal(saved.records.length, 8, "the 30-day-old record was pruned; all 8 concurrent ones kept");

    await writeFile(stateFilePath(env), "{ not json");
    assert.equal((await checkBeforeIssuing(["a.example.com"], false, env, NOW)).blocked, false);
  } finally {
    await cleanup();
  }
});
