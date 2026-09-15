import { readFile, writeFile, symlink, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  NGINX_SITES_AVAILABLE,
  NGINX_SITES_ENABLED,
  WEBSOCKET_TEMPLATE_PATH,
} from "../config.js";
import { assertValidDomain, assertValidUpstreamHost, assertValidPort } from "../validate.js";

const execFileAsync = promisify(execFile);

export interface CreateServerBlockInput {
  domain: string;
  upstream_host: string;
  upstream_port: number;
}

export interface CreateServerBlockResult {
  success: boolean;
  config_path?: string;
  test_output: string;
  reload_required: boolean;
}

export async function createServerBlock(
  input: CreateServerBlockInput
): Promise<CreateServerBlockResult> {
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
  const enabledPath = path.join(NGINX_SITES_ENABLED, domain);

  await writeFile(finalPath, rendered, "utf-8");

  try {
    const { stdout, stderr } = await execFileAsync("sudo", ["nginx", "-t"]);
    await symlink(finalPath, enabledPath);
    return {
      success: true,
      config_path: finalPath,
      test_output: stdout + stderr,
      reload_required: true,
    };
  } catch (err: any) {
    // Roll back - don't leave a broken config sitting in sites-available.
    await unlink(finalPath);
    return {
      success: false,
      test_output: err.stderr ?? String(err),
      reload_required: false,
    };
  }
}
