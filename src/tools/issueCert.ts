import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertValidDomain } from "../validate.js";
import { resolveCname, resolve4, resolve6 } from "node:dns/promises";

const execFileAsync = promisify(execFile);

export interface IssueCertInput {
  domain: string;
  staging?: boolean; // defaults to true - production LE has tight rate limits
  email?: string;
}

interface DnsCheckResult {
  resolves: boolean;
  record_type?: "A" | "AAAA" | "CNAME";
  values?: string[];
}

export interface IssueCertResult {
  success: boolean;
  certbot_output: string;
  dns_check?: DnsCheckResult;
}

async function checkDomainResolution(domain: string): Promise<DnsCheckResult> {
  // Check CNAME first - if this domain is itself a CNAME (your usual
  // mysite.julcap.net -> www.julcap.net setup), report that hop explicitly
  // rather than silently following it through to the final A/AAAA record.
  try {
    const targets = await resolveCname(domain);
    return { resolves: true, record_type: "CNAME", values: targets };
  } catch {
    // Not a CNAME - fall through to checking A/AAAA directly.
  }

  try {
    const addresses = await resolve4(domain);
    return { resolves: true, record_type: "A", values: addresses };
  } catch {
    try {
      const addresses = await resolve6(domain);
      return { resolves: true, record_type: "AAAA", values: addresses };
    } catch {
      return { resolves: false };
    }
  }
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
    return { success: true, certbot_output: stdout + stderr };
  } catch (err: any) {
    return { success: false, certbot_output: err.stderr ?? String(err) };
  }
}
