import { readFile, writeFile, symlink, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
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

  // Write to a temp path first and test THAT, not the live config directly.
  const tempPath = path.join(os.tmpdir(), `nginx-test-${domain}.conf`);
  await writeFile(tempPath, rendered, "utf-8");

  // TODO: `nginx -t` only validates the whole active config set, not a lone file.
  // Real implementation: copy tempPath into sites-available first, run `nginx -t`,
  // and roll back (delete the file) if the test fails. Sketch:
  //
  // const finalPath = path.join(NGINX_SITES_AVAILABLE, domain);
  // await writeFile(finalPath, rendered, "utf-8");
  // try {
  //   const { stdout, stderr } = await execFileAsync("nginx", ["-t"]);
  //   await symlink(finalPath, path.join(NGINX_SITES_ENABLED, domain));
  //   return { success: true, config_path: finalPath, test_output: stdout + stderr, reload_required: true };
  // } catch (err: any) {
  //   await unlink(finalPath); // roll back
  //   return { success: false, test_output: err.stderr ?? String(err), reload_required: false };
  // }

  throw new Error(
    "Not yet implemented - see TODO in createServerBlock.ts. " +
      `Rendered config is ready at ${tempPath} for manual inspection.`
  );
}
