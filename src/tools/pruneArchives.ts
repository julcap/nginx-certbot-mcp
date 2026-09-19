import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listArchivedSites, fileAgeDays } from "./listArchivedSites.js";

const execFileAsync = promisify(execFile);

export interface PruneArchivesInput {
  older_than_days?: number; // defaults to 30
  confirm: boolean;
  isAllowed?: (domain: string) => boolean; // restricts which domains' archives are considered
}

export interface PruneArchivesResult {
  success: boolean;
  message: string;
  pruned: string[]; // filenames removed (or, if !confirm, that would be removed)
}

export async function pruneArchives(input: PruneArchivesInput): Promise<PruneArchivesResult> {
  const { older_than_days = 30, confirm, isAllowed } = input;

  const all = (await listArchivedSites()).filter((a) => !isAllowed || isAllowed(a.domain));
  const stale: string[] = [];
  for (const archive of all) {
    if ((await fileAgeDays(archive.filename)) > older_than_days) {
      stale.push(archive.filename);
    }
  }

  if (stale.length === 0) {
    return { success: true, message: `No archives older than ${older_than_days} days.`, pruned: [] };
  }

  if (!confirm) {
    return {
      success: false,
      message:
        `Would delete ${stale.length} archive(s) older than ${older_than_days} days. ` +
        `Call again with confirm:true to proceed.`,
      pruned: stale,
    };
  }

  const removed: string[] = [];
  for (const filename of stale) {
    // filename is "<domain>.<timestamp>" - the wrapper's remove-archive
    // action re-derives and re-validates the domain from it independently.
    const domain = filename.replace(/\.\d{8}T\d{6}$/, "");
    try {
      await execFileAsync("sudo", ["/usr/local/bin/nginx-mcp-writesite", "remove-archive", domain, filename]);
      removed.push(filename);
    } catch {
      // Keep going - report what did get removed rather than aborting the batch.
    }
  }

  return {
    success: removed.length === stale.length,
    message: `Removed ${removed.length}/${stale.length} archive(s) older than ${older_than_days} days.`,
    pruned: removed,
  };
}
