import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertValidDomain } from "../validate.js";

const execFileAsync = promisify(execFile);

export interface DeleteCertInput {
  domain: string; // certbot cert name
  confirm: boolean;
}

export interface DeleteCertResult {
  success: boolean;
  message: string;
}

export async function deleteCert(input: DeleteCertInput): Promise<DeleteCertResult> {
  const { domain, confirm } = input;
  assertValidDomain(domain);

  if (!confirm) {
    return {
      success: false,
      message:
        `This will delete the certificate files for "${domain}" from certbot's store - any ` +
        `nginx config still referencing them will fail to reload afterward. Call again with ` +
        `confirm:true to proceed. If the cert may be compromised, use revoke_cert first.`,
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync("sudo", [
      "certbot", "delete",
      "--cert-name", domain,
      "--non-interactive",
    ]);
    return { success: true, message: stdout + stderr };
  } catch (err: any) {
    return { success: false, message: err.stderr ?? String(err) };
  }
}
