import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A local guard in front of production Let's Encrypt issuance. Staging has its
// own, far looser limits, so only production (staging:false) attempts are
// counted or refused. It only knows about issuances made through this server -
// Let's Encrypt's own limits stay the authority - but that is exactly the
// traffic an agent can burn through by retrying in a loop.

const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;

// https://letsencrypt.org/docs/rate-limits/
export const LIMITS = {
  duplicateCerts: 5, // per exact set of names, per 7 days
  failedValidations: 5, // per name, per hour
  certsPerRegisteredDomain: 50, // per registered domain, per 7 days
} as const;

export interface IssuanceRecord {
  ts: number; // epoch ms
  identifiers: string[]; // normalised: lowercase, sorted
  ok: boolean;
}

export interface Verdict {
  blocked: boolean;
  note?: string; // why it was blocked, or a heads-up that a limit is close
}

// --- pure logic ---

function normalise(identifiers: string[]): string[] {
  return [...new Set(identifiers.map((i) => i.toLowerCase().replace(/\.$/, "")))].sort();
}

// Second-level suffixes under a two-letter ccTLD (example.co.uk). Not the full
// Public Suffix List - good enough to group siblings for a soft local limit.
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);

export function registeredDomain(name: string): string {
  const labels = name.replace(/^\*\./, "").toLowerCase().split(".");
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const keep = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

const iso = (ms: number) => new Date(ms).toISOString();

export function evaluateIssuance(records: IssuanceRecord[], identifiers: string[], now: number): Verdict {
  const ids = normalise(identifiers);
  const key = ids.join(",");
  const label = ids.join(", ");
  const recent = (r: IssuanceRecord, window: number) => now - r.ts < window;
  const oldest = (rs: IssuanceRecord[]) => Math.min(...rs.map((r) => r.ts));
  const notes: string[] = [];

  const block = (what: string, count: number, limit: number, window: number, matching: IssuanceRecord[]): Verdict => ({
    blocked: true,
    note:
      `Refusing to request a production certificate for ${label}: ${what} (${count} counted, limit ${limit}). ` +
      `Retry after ${iso(oldest(matching) + window)}. This is counted from certificates issued through this ` +
      `server; pass staging:true to test without using up the real allowance, or set RATE_LIMIT_GUARD=off to disable this guard.`,
  });

  const duplicates = records.filter((r) => r.ok && recent(r, WEEK) && normalise(r.identifiers).join(",") === key);
  if (duplicates.length >= LIMITS.duplicateCerts) {
    return block("that exact set of names already has this many certificates issued in the past 7 days", duplicates.length, LIMITS.duplicateCerts, WEEK, duplicates);
  }
  if (duplicates.length === LIMITS.duplicateCerts - 1) {
    notes.push(`this is the last duplicate certificate for ${label} allowed this week`);
  }

  const failures = records.filter((r) => !r.ok && recent(r, HOUR) && r.identifiers.some((i) => ids.includes(i)));
  if (failures.length >= LIMITS.failedValidations) {
    return block("too many failed validations for these names in the past hour", failures.length, LIMITS.failedValidations, HOUR, failures);
  }
  if (failures.length >= LIMITS.failedValidations - 2) {
    notes.push(`${failures.length} failed validations in the past hour - fix the cause before retrying`);
  }

  const registered = new Set(ids.map(registeredDomain));
  const siblings = records.filter(
    (r) => r.ok && recent(r, WEEK) && r.identifiers.some((i) => registered.has(registeredDomain(i)))
  );
  if (siblings.length >= LIMITS.certsPerRegisteredDomain) {
    return block("too many certificates issued for this registered domain in the past 7 days", siblings.length, LIMITS.certsPerRegisteredDomain, WEEK, siblings);
  }
  if (siblings.length >= LIMITS.certsPerRegisteredDomain - 5) {
    notes.push(`${siblings.length} certificates issued for this registered domain in the past 7 days`);
  }

  return notes.length > 0 ? { blocked: false, note: `Heads-up: ${notes.join("; ")}.` } : { blocked: false };
}

// certbot fails for plenty of reasons that never reach Let's Encrypt (missing
// sudo rule, no nginx block). Only a failure that got as far as validation
// counts towards the failed-validation limit.
export function looksLikeValidationFailure(output: string): boolean {
  return /challenge|authorization|validation|urn:ietf:params:acme/i.test(output);
}

// --- persistence ---

export function guardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RATE_LIMIT_GUARD?.trim().toLowerCase() !== "off";
}

export function stateFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.MCP_STATE_DIR?.trim() || path.join(os.homedir(), ".nginx-certbot-mcp");
  return path.join(dir, "issuance.json");
}

async function readRecords(file: string, now: number): Promise<IssuanceRecord[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    const records: IssuanceRecord[] = Array.isArray(parsed?.records) ? parsed.records : [];
    return records.filter((r) => typeof r?.ts === "number" && Array.isArray(r.identifiers) && now - r.ts < WEEK);
  } catch {
    console.error(`[rate-guard] ${file} is not valid JSON; treating issuance history as empty.`);
    return [];
  }
}

// Serialises read-modify-write within this process.
let writeChain: Promise<unknown> = Promise.resolve();

async function appendRecord(file: string, record: IssuanceRecord, now: number): Promise<void> {
  const run = async () => {
    const records = await readRecords(file, now);
    records.push(record);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, records }, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  };
  writeChain = writeChain.then(run, run);
  await writeChain;
}

// Call before requesting a certificate. Staging and a disabled guard always pass.
export async function checkBeforeIssuing(
  identifiers: string[],
  staging: boolean,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now()
): Promise<Verdict> {
  if (staging || !guardEnabled(env)) return { blocked: false };
  try {
    return evaluateIssuance(await readRecords(stateFilePath(env), now), identifiers, now);
  } catch (err: any) {
    // An unreadable history shouldn't wedge issuance - Let's Encrypt still enforces its limits.
    console.error(`[rate-guard] could not read issuance history: ${err.message ?? err}`);
    return { blocked: false };
  }
}

// Call after certbot ran. Never throws.
export async function recordIssuance(
  identifiers: string[],
  staging: boolean,
  ok: boolean,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now()
): Promise<void> {
  if (staging || !guardEnabled(env)) return;
  try {
    await appendRecord(stateFilePath(env), { ts: now, identifiers: normalise(identifiers), ok }, now);
  } catch (err: any) {
    console.error(`[rate-guard] could not record issuance: ${err.message ?? err}`);
  }
}
