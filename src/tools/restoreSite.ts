import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertValidDomain } from "../validate.js";
import { NGINX_SITES_AVAILABLE } from "../config.js";
import { backupSite } from "../backups.js";
import { listArchivedSites } from "./listArchivedSites.js";
import { writeSiteAsRoot } from "./createSite.js";

const execFileAsync = promisify(execFile);

export interface RestoreSiteInput {
  domain: string;
  confirm: boolean;
  archive_filename?: string; // defaults to the most recent archive for the domain
}

export interface RestoreSiteResult {
  success: boolean;
  message: string;
  reload_required: boolean;
}

async function runWrapper(args: string[]) {
  return execFileAsync("sudo", ["/usr/local/bin/nginx-mcp-writesite", ...args]);
}

export async function restoreSite(input: RestoreSiteInput): Promise<RestoreSiteResult> {
  const { domain, confirm, archive_filename } = input;
  assertValidDomain(domain);

  const archives = await listArchivedSites(domain);
  if (archives.length === 0) {
    return {
      success: false,
      message: `No archived config found for "${domain}" - nothing to restore.`,
      reload_required: false,
    };
  }

  const target = archive_filename
    ? archives.find((a) => a.filename === archive_filename)
    : archives[0];
  if (!target) {
    return {
      success: false,
      message: `"${archive_filename}" is not an archived config for "${domain}". ` +
        `Call list_archived_sites to see what's available.`,
      reload_required: false,
    };
  }

  if (!confirm) {
    return {
      success: false,
      message:
        `This will restore "${domain}" from the archive dated ${target.archived_at} and ` +
        `enable it, overwriting any current config for that domain. ` +
        `Call again with confirm:true to proceed.`,
      reload_required: false,
    };
  }

  // The restore overwrites any current config, so snapshot it first and put
  // it back if the archived one doesn't pass `nginx -t`.
  const previous = await readFile(path.join(NGINX_SITES_AVAILABLE, domain), "utf-8").catch(() => null);
  if (previous !== null) {
    try {
      await backupSite(domain);
    } catch (err: any) {
      return { success: false, message: err.message, reload_required: false };
    }
  }

  try {
    await runWrapper(["restore", domain, target.filename]);
    const test = await execFileAsync("sudo", ["nginx", "-t"]);
    await runWrapper(["enable", domain]);
    return {
      success: true,
      message: `Restored "${domain}" from ${target.archived_at} and enabled it. ` +
        `${test.stdout}${test.stderr} Call reload_nginx to apply.`,
      reload_required: true,
    };
  } catch (err: any) {
    // Test (or enable) failed - undo the restore rather than leaving a
    // half-applied config sitting in sites-available.
    if (previous !== null) await writeSiteAsRoot(domain, previous).catch(() => {});
    else await runWrapper(["remove", domain]).catch(() => {});
    return {
      success: false,
      message: err.stderr ?? err.message ?? String(err),
      reload_required: false,
    };
  }
}
