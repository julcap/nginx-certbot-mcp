import { appendFile, mkdir, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Append-only JSONL audit trail of tool calls. One line per call, written
// after the call finishes (or is refused), so each line carries its outcome.

export type AuditOutcome =
  | "ok" // the tool ran and (if it reports success at all) succeeded
  | "failed" // the tool ran and reported success:false, e.g. a failed `nginx -t` or an unconfirmed dry run
  | "error" // the tool threw (bad input, missing sudo rule, ...)
  | "denied"; // refused by policy before running

export interface AuditEntry {
  ts: string;
  tool: string;
  mutating: boolean;
  client?: string;
  args: Record<string, unknown>;
  dry_run?: boolean;
  outcome: AuditOutcome;
  message?: string;
  operation_id?: string;
  duration_ms: number;
}

export const DEFAULT_AUDIT_PATH = path.join(os.homedir(), ".nginx-certbot-mcp", "audit.jsonl");

// `AUDIT_LOG_PATH` unset -> default path. "off" disables the log entirely.
export function resolveAuditPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.AUDIT_LOG_PATH?.trim();
  if (!raw) return DEFAULT_AUDIT_PATH;
  if (raw.toLowerCase() === "off") return null;
  return path.resolve(raw);
}

const SECRET_KEY_RE = /secret|password|passwd|token|api[_-]?key|access[_-]?key|credential/i;
const MAX_STRING = 500;

// Tool args are logged verbatim except for anything that looks like a
// credential, and over-long strings (e.g. a huge TXT value) are truncated.
export function redactArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = "[redacted]";
    } else if (typeof value === "string" && value.length > MAX_STRING) {
      out[key] = value.slice(0, MAX_STRING) + `… [+${value.length - MAX_STRING} chars]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function truncate(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

export class AuditLogger {
  constructor(
    private readonly filePath: string | null,
    readonly logReads: boolean = false
  ) {}

  get enabled(): boolean {
    return this.filePath !== null;
  }

  get path(): string | null {
    return this.filePath;
  }

  // Called once at startup: an audit log we can't write to is a reason to
  // refuse to start, not something to discover after the first mutation.
  async init(): Promise<void> {
    if (!this.filePath) return;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const handle = await open(this.filePath, "a", 0o600);
      await handle.close();
    } catch (err: any) {
      throw new Error(
        `Cannot write audit log at ${this.filePath}: ${err.message ?? err}. ` +
          `Set AUDIT_LOG_PATH to a writable file, or AUDIT_LOG_PATH=off to disable auditing.`
      );
    }
  }

  // Never throws: the action being audited has already happened (or been
  // refused), so a logging failure must not turn into a tool failure.
  async record(entry: AuditEntry): Promise<void> {
    if (!this.filePath) return;
    try {
      await appendFile(this.filePath, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch (err: any) {
      console.error(`[audit] failed to write ${this.filePath}: ${err.message ?? err}`);
    }
  }
}
