import { readFile } from "node:fs/promises";
import path from "node:path";
import { NGINX_SITES_AVAILABLE } from "../config.js";
import { assertValidDomain } from "../validate.js";

export async function getSiteConfig(domain: string): Promise<{ domain: string; raw_config: string }> {
  assertValidDomain(domain);
  const configPath = path.join(NGINX_SITES_AVAILABLE, domain);

  try {
    const raw = await readFile(configPath, "utf-8");
    return { domain, raw_config: raw };
  } catch (err) {
    throw new Error(`No config found for "${domain}" at ${configPath}`);
  }
}
