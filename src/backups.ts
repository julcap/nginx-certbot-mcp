import { readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { ARCHIVE_FILENAME_RE, BACKUP_DIR, NGINX_SITES_AVAILABLE } from "./config.js";
import { timestampToDisplay } from "./tools/listArchivedSites.js";

const execFileAsync = promisify(execFile);
const WRAPPER = "/usr/local/bin/nginx-mcp-writesite";

// Snapshots of a site's config taken just before create_site, update_site,
// restore_site or rollback_site changed it. Kept apart from the archive
// directory: archives are "this site was deleted", backups are "this is what
// it looked like before the last change".

export interface SiteBackup {
  domain: string;
  filename: string;
  backed_up_at: string; // "YYYY-MM-DD HH:MM:SS", server-local time
}

// Newest first. Filter by domain when given.
export async function listSiteBackups(domain?: string): Promise<SiteBackup[]> {
  let entries: string[];
  try {
    entries = await readdir(BACKUP_DIR);
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const results: SiteBackup[] = [];
  for (const filename of entries) {
    const match = filename.match(ARCHIVE_FILENAME_RE);
    if (!match) continue;
    const [, fileDomain, timestamp] = match;
    if (domain && fileDomain !== domain) continue;
    results.push({ domain: fileDomain, filename, backed_up_at: timestampToDisplay(timestamp) });
  }
  return results.sort((a, b) => (a.filename < b.filename ? 1 : -1));
}

// Takes a snapshot of the domain's current config. Returns false when there is
// no config yet (nothing to protect). Throws if the snapshot can't be taken -
// callers treat that as a reason not to go ahead with the change.
export async function backupSite(domain: string): Promise<boolean> {
  try {
    await stat(path.join(NGINX_SITES_AVAILABLE, domain));
  } catch {
    return false;
  }
  try {
    await execFileAsync("sudo", [WRAPPER, "backup", domain]);
    return true;
  } catch (err: any) {
    throw new Error(
      `Could not back up the current config for "${domain}" first, so nothing was changed: ` +
        `${(err.stderr || err.message || String(err)).trim()} ` +
        `(If the message is a usage error, the installed helper predates backups - re-run "npm run setup -- <user>".)`
    );
  }
}

export async function restoreBackupFile(domain: string, filename: string): Promise<void> {
  await execFileAsync("sudo", [WRAPPER, "restore-backup", domain, filename]);
}
