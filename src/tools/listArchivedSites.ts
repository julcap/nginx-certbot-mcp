import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_DIR, ARCHIVE_FILENAME_RE } from "../config.js";

export interface ArchivedSite {
  domain: string;
  filename: string;
  archived_at: string; // "YYYY-MM-DD HH:MM:SS", server-local time from the archive timestamp
}

export function timestampToDisplay(ts: string): string {
  // "YYYYMMDDTHHMMSS" -> "YYYY-MM-DD HH:MM:SS"
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!m) return ts;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

// Filter by domain when given; otherwise lists every archived config.
export async function listArchivedSites(domain?: string): Promise<ArchivedSite[]> {
  let entries: string[];
  try {
    entries = await readdir(ARCHIVE_DIR);
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const results: ArchivedSite[] = [];
  for (const filename of entries) {
    const match = filename.match(ARCHIVE_FILENAME_RE);
    if (!match) continue;
    const [, fileDomain, timestamp] = match;
    if (domain && fileDomain !== domain) continue;
    results.push({ domain: fileDomain, filename, archived_at: timestampToDisplay(timestamp) });
  }

  // Newest first, so "most recent archive for this domain" is results[0].
  return results.sort((a, b) => (a.filename < b.filename ? 1 : -1));
}

export async function fileAgeDays(filename: string): Promise<number> {
  const stats = await stat(path.join(ARCHIVE_DIR, filename));
  return (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
}
