import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertValidDomain } from "../validate.js";

const execFileAsync = promisify(execFile);

export interface IssueCertInput {
  domain: string;
  staging?: boolean; // defaults to true - production LE has tight rate limits
  email?: string;
}

export interface IssueCertResult {
  success: boolean;
  certbot_output: string;
}

export async function issueCert(input: IssueCertInput): Promise<IssueCertResult> {
  const { domain, staging = true, email } = input;
  assertValidDomain(domain);

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
