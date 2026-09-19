import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers.js";

// Runs the real wrapper script, with its /etc/nginx paths pointed at a temp
// directory, so the backup/restore-backup logic is exercised without root.
async function sandbox() {
  const { dir, cleanup } = await tempDir();
  const script = readFileSync("scripts/nginx-mcp-writesite", "utf-8")
    .replace('SITES_AVAILABLE="/etc/nginx/sites-available"', `SITES_AVAILABLE="${dir}/available"`)
    .replace('SITES_ENABLED="/etc/nginx/sites-enabled"', `SITES_ENABLED="${dir}/enabled"`)
    .replace('ARCHIVE_DIR="/etc/nginx/sites-archived"', `ARCHIVE_DIR="${dir}/archived"`)
    .replace('BACKUP_DIR="/etc/nginx/sites-backups"', `BACKUP_DIR="${dir}/backups"`);
  const scriptPath = path.join(dir, "wrapper.sh");
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
  mkdirSync(`${dir}/available`);
  mkdirSync(`${dir}/enabled`);

  const run = (...args: string[]) => spawnSync("bash", [scriptPath, ...args], { encoding: "utf-8" });
  const backups = () => (existsSync(`${dir}/backups`) ? readdirSync(`${dir}/backups`).sort() : []);
  const write = (domain: string, content: string) => writeFileSync(`${dir}/available/${domain}`, content);
  return { dir, run, backups, write, cleanup };
}

test("backup snapshots the current config and fails cleanly when there is none", async () => {
  const sb = await sandbox();
  try {
    const missing = sb.run("backup", "a.example.com");
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /No config to back up/);

    sb.write("a.example.com", "server { v1 }");
    assert.equal(sb.run("backup", "a.example.com").status, 0);
    const [file] = sb.backups();
    assert.match(file, /^a\.example\.com\.\d{8}T\d{6}$/);
    assert.equal(readFileSync(`${sb.dir}/backups/${file}`, "utf-8"), "server { v1 }");
  } finally {
    await sb.cleanup();
  }
});

test("restore-backup copies the chosen snapshot back", async () => {
  const sb = await sandbox();
  try {
    sb.write("a.example.com", "old");
    sb.run("backup", "a.example.com");
    const [file] = sb.backups();
    sb.write("a.example.com", "new");

    assert.equal(sb.run("restore-backup", "a.example.com", file).status, 0);
    assert.equal(readFileSync(`${sb.dir}/available/a.example.com`, "utf-8"), "old");
  } finally {
    await sb.cleanup();
  }
});

test("restore-backup rejects traversal, foreign-domain and missing files", async () => {
  const sb = await sandbox();
  try {
    sb.write("a.example.com", "x");
    sb.run("backup", "a.example.com");
    const [file] = sb.backups();
    const other = file.replace("a.example.com", "b.example.com");

    for (const bad of ["../available/a.example.com", `../backups/${file}`, other, "a.example.com.20200101T000000", "a.example.com"]) {
      const r = sb.run("restore-backup", "a.example.com", bad);
      assert.notEqual(r.status, 0, `should reject ${bad}`);
    }
    assert.equal(readFileSync(`${sb.dir}/available/a.example.com`, "utf-8"), "x");
  } finally {
    await sb.cleanup();
  }
});

test("backup keeps the newest 10 per domain and never touches other domains", async () => {
  const sb = await sandbox();
  try {
    mkdirSync(`${sb.dir}/backups`);
    // 14 pre-existing snapshots for a.com, plus a look-alike domain that shares its prefix.
    for (let i = 1; i <= 14; i++) {
      writeFileSync(`${sb.dir}/backups/a.com.202601${String(i).padStart(2, "0")}T000000`, `s${i}`);
    }
    writeFileSync(`${sb.dir}/backups/a.com.b.com.20260101T000000`, "lookalike");
    writeFileSync(`${sb.dir}/backups/other.org.20260101T000000`, "other");

    sb.write("a.com", "current");
    assert.equal(sb.run("backup", "a.com").status, 0);

    const files = sb.backups();
    const mine = files.filter((f) => /^a\.com\.\d{8}T\d{6}$/.test(f));
    assert.equal(mine.length, 10);
    assert.ok(!mine.includes("a.com.20260101T000000"), "oldest were pruned");
    assert.ok(files.includes("a.com.b.com.20260101T000000"), "look-alike domain untouched");
    assert.ok(files.includes("other.org.20260101T000000"), "other domain untouched");
  } finally {
    await sb.cleanup();
  }
});

test("wrapper script stays valid bash", () => {
  execFileSync("bash", ["-n", "scripts/nginx-mcp-writesite"]);
});
