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
    // --no-delete-after-revoke: certbot's default is actually to delete the
    // cert files as part of revoke (despite the flag being named like an
    // opt-in) - explicit here so revoke only revokes, leaving the
    // (now-untrusted) files on disk for delete_cert to remove separately.
    const { stdout, stderr } = await execFileAsync("sudo", [
      "certbot", "revoke",
      "--cert-name", domain,
      "--non-interactive",
      "--no-delete-after-revoke",
    ]);
    return { success: true, message: stdout + stderr };
  } catch (err: any) {
    return { success: false, message: err.stderr ?? String(err) };
  }
}
