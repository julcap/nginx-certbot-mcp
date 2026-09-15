import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { NGINX_SITES_AVAILABLE, ARCHIVE_DIR } from "../config.js";
import { assertValidDomain } from "../validate.js";

const execFileAsync = promisify(execFile);

export interface RemoveSiteInput {
  domain: string;
  confirm: boolean;
}

export interface RemoveSiteResult {
  success: boolean;
  message: string;
  reload_required: boolean;
}

async function runWrapper(action: "disable" | "archive" | "remove", domain: string) {
  await execFileAsync("sudo", ["/usr/local/bin/nginx-mcp-writesite", action, domain]);
}

export async function removeSite(input: RemoveSiteInput): Promise<RemoveSiteResult> {
  const { domain, confirm } = input;
  assertValidDomain(domain);

  // Destructive - require an explicit, separate confirmation rather than
  // acting on the first call. No side effects happen below this point
  // until confirm is true.
  if (!confirm) {
    return {
      success: false,
      message: `This will disable and remove the nginx config for "${domain}" (a copy is kept ` +
        `under ${ARCHIVE_DIR}, but it will stop serving traffic immediately). ` +
        `Call again with confirm:true to proceed.`,
      reload_required: false,
    };
  }

  const configPath = path.join(NGINX_SITES_AVAILABLE, domain);
  try {
    await readFile(configPath, "utf-8");
  } catch {
    return {
      success: false,
      message: `No config found for "${domain}" at ${configPath} - nothing to remove.`,
      reload_required: false,
    };
  }

  try {
    // Order matters: stop serving the site first, then keep a copy before
    // the delete that can't be undone.
    await runWrapper("disable", domain);
    await runWrapper("archive", domain);
    await runWrapper("remove", domain);
    return {
      success: true,
      message: `Removed "${domain}" (disabled, archived to ${ARCHIVE_DIR}, deleted from ` +
        `sites-available). Existing certbot certificates for this domain were not touched - ` +
        `use check_cert_expiry to review them separately. Call reload_nginx to apply.`,
      reload_required: true,
    };
  } catch (err: any) {
    return {
      success: false,
      message: err.stderr ?? err.message ?? String(err),
      reload_required: false,
    };
  }
}
