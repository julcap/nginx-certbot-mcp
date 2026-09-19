import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { NGINX_SITES_AVAILABLE } from "../config.js";
import { assertValidDomain } from "../validate.js";
import { backupSite, listSiteBackups, restoreBackupFile } from "../backups.js";
import { writeSiteAsRoot } from "./createSite.js";

const execFileAsync = promisify(execFile);

export interface RollbackSiteInput {
  domain: string;
  confirm: boolean;
  backup_filename?: string; // defaults to the newest backup for the domain
}

export interface RollbackSiteResult {
  success: boolean;
  message: string;
  reload_required: boolean;
}

export async function rollbackSite(input: RollbackSiteInput): Promise<RollbackSiteResult> {
  const { domain, confirm, backup_filename } = input;
  assertValidDomain(domain);

  const backups = await listSiteBackups(domain);
  if (backups.length === 0) {
    return {
      success: false,
      message: `No backups found for "${domain}". Backups are taken automatically before ` +
        `create_site, update_site, restore_site and rollback_site change a config.`,
      reload_required: false,
    };
  }

  const target = backup_filename ? backups.find((b) => b.filename === backup_filename) : backups[0];
  if (!target) {
    return {
      success: false,
      message: `"${backup_filename}" is not a backup of "${domain}". Call list_site_backups to see what's available.`,
      reload_required: false,
    };
  }

  if (!confirm) {
    return {
      success: false,
      message:
        `This will replace the current config for "${domain}" with the backup from ${target.backed_up_at}. ` +
        `The current config is backed up first, so rolling back again undoes this. ` +
        `Call again with confirm:true to proceed.`,
      reload_required: false,
    };
  }

  const configPath = path.join(NGINX_SITES_AVAILABLE, domain);
  const previous = await readFile(configPath, "utf-8").catch(() => null);

  try {
    // Snapshot what's there now, so the rollback is itself reversible.
    if (previous !== null) await backupSite(domain);
  } catch (err: any) {
    return { success: false, message: err.message, reload_required: false };
  }

  try {
    await restoreBackupFile(domain, target.filename);
    const test = await execFileAsync("sudo", ["nginx", "-t"]);
    await execFileAsync("sudo", ["/usr/local/bin/nginx-mcp-writesite", "enable", domain]);
    return {
      success: true,
      message: `Rolled "${domain}" back to the backup from ${target.backed_up_at}. ` +
        `${test.stdout}${test.stderr} Call reload_nginx to apply.`,
      reload_required: true,
    };
  } catch (err: any) {
    // The backup didn't pass `nginx -t` (e.g. it references a cert that's since
    // been deleted) - put back exactly what was there before.
    if (previous !== null) await writeSiteAsRoot(domain, previous).catch(() => {});
    else await execFileAsync("sudo", ["/usr/local/bin/nginx-mcp-writesite", "remove", domain]).catch(() => {});
    return {
      success: false,
      message: `The backup from ${target.backed_up_at} failed \`nginx -t\`, so the current config was left in place: ` +
        `${err.stderr ?? err.message ?? String(err)}`,
      reload_required: false,
    };
  }
}
