import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { NGINX_SITES_ENABLED } from "../config.js";

export interface SiteSummary {
  domain: string;
  config_path: string;
  upstream: string | null;
  ssl_enabled: boolean;
}

// Very small, tolerant parser. Good enough for summary listing; get_site_config
// returns the raw file for anything that needs precision.
function extractField(content: string, directive: string): string | null {
  const re = new RegExp(`${directive}\\s+([^;]+);`, "m");
  const match = content.match(re);
  return match ? match[1].trim() : null;
}

export async function listSites(): Promise<SiteSummary[]> {
  const entries = await readdir(NGINX_SITES_ENABLED);
  const sites: SiteSummary[] = [];

  for (const entry of entries) {
    const fullPath = path.join(NGINX_SITES_ENABLED, entry);
    const stat = await lstat(fullPath);
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;

    const content = await readFile(fullPath, "utf-8").catch(() => "");
    if (!content) continue;

    const domain = extractField(content, "server_name") ?? entry;
    const proxyPass = extractField(content, "proxy_pass");
    const sslEnabled = /listen\s+443\s+ssl/.test(content) || content.includes("ssl_certificate ");

    sites.push({
      domain,
      config_path: fullPath,
      upstream: proxyPass,
      ssl_enabled: sslEnabled,
    });
  }

  return sites;
}
