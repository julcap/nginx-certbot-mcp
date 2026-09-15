import { readFile, writeFile, symlink, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  NGINX_SITES_AVAILABLE,
  NGINX_SITES_ENABLED,
  WEBSOCKET_TEMPLATE_PATH,
} from "../config.js";
import { assertValidDomain, assertValidUpstreamHost, assertValidPort } from "../validate.js";

const execFileAsync = promisify(execFile);

export interface CreateSiteInput {
  domain: string;
  upstream_host: string;
  upstream_port: number;
}

export interface CreateSiteResult {
  success: boolean;
  config_path?: string;
  test_output: string;
  reload_required: boolean;
}

function writeSiteAsRoot(domain: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("sudo", ["/usr/local/bin/nginx-mcp-writesite", "write", domain], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr || `exited ${code}`))));
    proc.stdin.write(content);
    proc.stdin.end();
  });
}
export async function createSite(
  input: CreateSiteInput
): Promise<CreateSiteResult> {
  const { domain, upstream_host, upstream_port } = input;

  // Validate everything before it touches a file or template - this is the
  // injection guard the spec calls for.
  assertValidDomain(domain);
  assertValidUpstreamHost(upstream_host);
  assertValidPort(upstream_port);

  const template = await readFile(WEBSOCKET_TEMPLATE_PATH, "utf-8");
  const rendered = template
    .replaceAll("{{DOMAIN}}", domain)
    .replaceAll("{{UPSTREAM_HOST}}", upstream_host)
    .replaceAll("{{UPSTREAM_PORT}}", String(upstream_port));

  const finalPath = path.join(NGINX_SITES_AVAILABLE, domain);

  await writeSiteAsRoot(domain, rendered);

  try {
    const { stdout, stderr } = await execFileAsync("sudo", ["nginx", "-t"]);
    await execFileAsync("sudo", ["/usr/local/bin/nginx-mcp-writesite", "enable", domain]);
    return {
      success: true,
      config_path: finalPath,
      test_output: stdout + stderr,
      reload_required: true
    };
  } catch (err: any) {
    await execFileAsync("sudo", ["/usr/local/bin/nginx-mcp-writesite", "remove", domain]);
    return {
      success: false,
      test_output: err.stderr ?? String(err),
      reload_required: false
    };
  }
}
