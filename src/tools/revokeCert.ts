import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertValidDomain } from "../validate.js";

const execFileAsync = promisify(execFile);

export interface RevokeCertInput {
  domain: string; // certbot cert name
  confirm: boolean;
}

export interface RevokeCertResult {
  success: boolean;
  message: string;
}

export async function revokeCert(input: RevokeCertInput): Promise<RevokeCertResult> {
  const { domain, confirm } = input;
  assertValidDomain(domain);

  // Revoking tells the CA to distrust the cert immediately, browser-wide -
  // irreversible in effect (you'd need to issue a brand new cert). Require
  // explicit confirmation.
  if (!confirm) {
    return {
      success: false,
      message:
        `This will revoke the certificate for "${domain}" with Let's Encrypt - any site ` +
        `still serving it will show as untrusted immediately. Call again with confirm:true ` +
        `to proceed.`,
    };
  }

  try {
    // Revokes only - leaves the (now-untrusted) cert files on disk so
    // delete_cert stays the one tool responsible for removing them.
    const { stdout, stderr } = await execFileAsync("sudo", [
      "certbot", "revoke",
      "--cert-name", domain,
      "--non-interactive",
    ]);
    return { success: true, message: stdout + stderr };
  } catch (err: any) {
    return { success: false, message: err.stderr ?? String(err) };
  }
}
