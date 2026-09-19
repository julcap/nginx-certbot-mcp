import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertValidDomain } from "../validate.js";
import { checkBeforeIssuing, looksLikeValidationFailure, recordIssuance } from "../rateGuard.js";

const execFileAsync = promisify(execFile);

export interface IssueWildcardCertInput {
  domain: string; // base domain, e.g. "julcap.net" - certs both it and "*.julcap.net"
  staging?: boolean;
  email?: string;
}

export interface IssueWildcardCertResult {
  success: boolean;
  certbot_output: string;
  rate_limit_note?: string; // set when the local guard refused, or a production limit is close
}

// Wildcard certs require DNS-01 validation (HTTP-01, what issue_cert uses,
// can't prove ownership of a wildcard) - this uses the certbot-dns-route53
// plugin, which must be installed on the box separately (see README).
export async function issueWildcardCert(
  input: IssueWildcardCertInput
): Promise<IssueWildcardCertResult> {
  const { domain, staging = true, email } = input;
  assertValidDomain(domain);

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    return {
      success: false,
      certbot_output:
        "Missing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY - copy .env.example to .env and " +
        "fill them in. certbot-dns-route53 needs these to create the DNS-01 challenge record.",
    };
  }

  // Production only: refuse before spending an attempt that Let's Encrypt
  // would count against the real per-week limits.
  const names = [domain, `*.${domain}`];
  const verdict = await checkBeforeIssuing(names, staging);
  if (verdict.blocked) {
    return { success: false, certbot_output: verdict.note!, rate_limit_note: verdict.note };
  }

  const args = [
    "certonly",
    "--dns-route53",
    "-d", domain,
    "-d", `*.${domain}`,
    "--non-interactive",
    "--agree-tos",
  ];
  if (staging) args.push("--staging");
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`Invalid email: "${email}"`);
    }
    args.push("-m", email);
  } else {
    args.push("--register-unsafely-without-email");
  }

  try {
    // sudoers grants env_keep for exactly these vars for this command - see
    // scripts/install-sudoers.sh. AWS_DEFAULT_REGION: Route 53 is global,
    // but certbot-dns-route53's boto3 client still wants a region hint,
    // which won't exist via ~/.aws/config on a freshly provisioned box.
    const { stdout, stderr } = await execFileAsync("sudo", ["certbot", ...args], {
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: accessKeyId,
        AWS_SECRET_ACCESS_KEY: secretAccessKey,
        AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "us-east-1",
      },
    });
    await recordIssuance(names, staging, true);
    return { success: true, certbot_output: stdout + stderr, rate_limit_note: verdict.note };
  } catch (err: any) {
    const output = err.stderr ?? String(err);
    if (looksLikeValidationFailure(output)) await recordIssuance(names, staging, false);
    return { success: false, certbot_output: output, rate_limit_note: verdict.note };
  }
}
