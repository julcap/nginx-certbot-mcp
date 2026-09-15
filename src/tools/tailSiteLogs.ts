import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_LOG_LINES } from "../config.js";

const execFileAsync = promisify(execFile);

export interface TailSiteLogsInput {
  log_type: "access" | "error";
  lines?: number; // defaults to 100, capped at MAX_LOG_LINES
  domain?: string; // best-effort substring filter - see caveat below
}

export interface TailSiteLogsResult {
  success: boolean;
  lines: string[];
  note?: string;
}

export async function tailSiteLogs(input: TailSiteLogsInput): Promise<TailSiteLogsResult> {
  const { log_type, lines = 100, domain } = input;
  const count = Math.min(lines, MAX_LOG_LINES);

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("sudo", [
      "/usr/local/bin/nginx-mcp-writesite",
      "log",
      log_type,
      String(count),
    ]));
  } catch (err: any) {
    return { success: false, lines: [], note: err.stderr ?? err.message ?? String(err) };
  }

  let out = stdout.split("\n").filter(Boolean);
  let note: string | undefined;
  if (domain) {
    out = out.filter((line) => line.includes(domain));
    // The default nginx log format doesn't include the Host header, so this
    // is a best-effort substring match (e.g. against URLs), not a real
    // per-vhost filter - only reliable if the domain string shows up in the
    // request line itself.
    note =
      `Filtered by substring "${domain}" - nginx's default log format has no per-vhost ` +
      `field, so this may miss or over-match lines. For real per-site logs, add a ` +
      `"log_format" with $host and per-server access_log/error_log directives.`;
  }

  return { success: true, lines: out, note };
}
