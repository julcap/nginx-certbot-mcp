import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { NGINX_SITES_AVAILABLE } from "../config.js";
import { assertValidDomain, assertValidUpstreamHost, assertValidPort } from "../validate.js";
import { writeSiteAsRoot } from "./createSite.js";

const execFileAsync = promisify(execFile);

export interface UpdateSiteInput {
  domain: string;
  upstream_host: string;
  upstream_port: number;
}

export interface UpdateSiteResult {
  success: boolean;
  test_output: string;
  reload_required: boolean;
}

// Only the proxy_pass target(s) are rewritten - everything else in the config
// is left untouched. Re-rendering from create_site's template instead would
// silently strip any SSL server block issue_cert/certbot added since.
const PROXY_PASS_RE = /proxy_pass\s+http:\/\/[^;]+;/g;

export async function updateSite(input: UpdateSiteInput): Promise<UpdateSiteResult> {
  const { domain, upstream_host, upstream_port } = input;

  assertValidDomain(domain);
  assertValidUpstreamHost(upstream_host);
  assertValidPort(upstream_port);

  const configPath = path.join(NGINX_SITES_AVAILABLE, domain);
  let previous: string;
  try {
    previous = await readFile(configPath, "utf-8");
  } catch {
    return {
      success: false,
      test_output: `No existing config for "${domain}" at ${configPath} - use create_site to create one.`,
      reload_required: false,
    };
  }

  let count = 0;
  const rendered = previous.replace(PROXY_PASS_RE, () => {
    count++;
    return `proxy_pass http://${upstream_host}:${upstream_port};`;
  });

  if (count === 0) {
    return {
      success: false,
      test_output: `No "proxy_pass http://...;" directive found in "${domain}"'s config - nothing to update.`,
      reload_required: false,
    };
  }

  await writeSiteAsRoot(domain, rendered);

  try {
    const { stdout, stderr } = await execFileAsync("sudo", ["nginx", "-t"]);
    return { success: true, test_output: stdout + stderr, reload_required: true };
  } catch (err: any) {
    // Test failed - roll back to the previous config rather than leaving a
    // broken one sitting in sites-available.
    await writeSiteAsRoot(domain, previous);
    return { success: false, test_output: err.stderr ?? String(err), reload_required: false };
  }
}
