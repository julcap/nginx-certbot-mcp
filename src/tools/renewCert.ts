import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertValidDomain } from "../validate.js";

const execFileAsync = promisify(execFile);

export interface RenewCertInput {
  domain?: string; // certbot lineage/cert name; omit to renew everything due
  dry_run?: boolean; // defaults to true - matches issue_cert's staging-first default
}

export interface RenewCertResult {
  success: boolean;
  certbot_output: string;
}

export async function renewCert(input: RenewCertInput): Promise<RenewCertResult> {
  const { domain, dry_run = true } = input;
  if (domain) assertValidDomain(domain);

  const args = ["renew", "--non-interactive"];
  if (domain) args.push("--cert-name", domain);
  // --dry-run simulates the full renewal against Let's Encrypt's staging
  // environment without touching the live cert or the rate limit - keep
  // this the default the same way issue_cert defaults to staging.
  if (dry_run) args.push("--dry-run");

  try {
    const { stdout, stderr } = await execFileAsync("sudo", ["certbot", ...args]);
    return { success: true, certbot_output: stdout + stderr };
  } catch (err: any) {
    return { success: false, certbot_output: err.stderr ?? String(err) };
  }
}
