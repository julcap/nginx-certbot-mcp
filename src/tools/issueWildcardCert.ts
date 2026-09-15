import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertValidDomain } from "../validate.js";

const execFileAsync = promisify(execFile);

export interface IssueWildcardCertInput {
  domain: string; // base domain, e.g. "julcap.net" - certs both it and "*.julcap.net"
  staging?: boolean;
  email?: string;
}

export interface IssueWildcardCertResult {
  success: boolean;
  certbot_output: string;
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
    // sudoers grants env_keep for exactly these two vars for this command -
    // see scripts/install-sudoers.sh.
    const { stdout, stderr } = await execFileAsync("sudo", ["certbot", ...args], {
      env: { ...process.env, AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey },
    });
    return { success: true, certbot_output: stdout + stderr };
  } catch (err: any) {
    return { success: false, certbot_output: err.stderr ?? String(err) };
  }
}
