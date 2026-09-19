import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertValidDomain } from "../validate.js";
import { checkDomainResolution, type DnsCheckResult } from "../dns.js";
import { checkBeforeIssuing, looksLikeValidationFailure, recordIssuance } from "../rateGuard.js";

const execFileAsync = promisify(execFile);

export interface IssueCertInput {
  domain: string;
  staging?: boolean; // defaults to true - production LE has tight rate limits
  email?: string;
}

export interface IssueCertResult {
  success: boolean;
  certbot_output: string;
  dns_check?: DnsCheckResult;
  rate_limit_note?: string; // set when the local guard refused, or a production limit is close
}

export async function issueCert(input: IssueCertInput): Promise<IssueCertResult> {
  const { domain, staging = true, email } = input;
  assertValidDomain(domain);

  // Fail fast with a clear message rather than letting certbot's HTTP-01
  // challenge fail after the fact - saves a wasted attempt against
  // Let's Encrypt's rate limit in production mode.
  const dnsCheck = await checkDomainResolution(domain);
  if (!dnsCheck.resolves) {
    return {
      success: false,
      certbot_output:
          `"${domain}" does not resolve to anything yet. Run create_domain_record ` +
          `first and wait for DNS propagation before calling issue_cert.`,
      dns_check: dnsCheck,
    };
  }

  // Production only: refuse before spending an attempt that Let's Encrypt
  // would count against the real per-week limits.
  const verdict = await checkBeforeIssuing([domain], staging);
  if (verdict.blocked) {
    return { success: false, certbot_output: verdict.note!, rate_limit_note: verdict.note };
  }

  const args = ["--nginx", "-d", domain, "--non-interactive", "--agree-tos"];
  if (staging) args.push("--staging");
  if (email) {
    // email is not domain-validated above; do a light sanity check here too
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`Invalid email: "${email}"`);
    }
    args.push("-m", email);
  } else {
    args.push("--register-unsafely-without-email");
  }

  // TODO: this actually calls certbot - keep `staging: true` as the default
  // path exercised in dev/testing. Only flip to false deliberately.
  try {
    const { stdout, stderr } = await execFileAsync("sudo", ["certbot", ...args]);
    await recordIssuance([domain], staging, true);
    return { success: true, certbot_output: stdout + stderr, rate_limit_note: verdict.note };
  } catch (err: any) {
    const output = err.stderr ?? String(err);
    if (looksLikeValidationFailure(output)) await recordIssuance([domain], staging, false);
    return { success: false, certbot_output: output, rate_limit_note: verdict.note };
  }
}
