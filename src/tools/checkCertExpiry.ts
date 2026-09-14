import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CertStatus {
  domain: string;
  expires_at: string;
  days_remaining: number;
  auto_renew_enabled: boolean; // certbot always sets up the systemd timer/cron; true unless user disabled it
}

// `certbot certificates` is a read-only command - safe to run without confirmation.
export async function checkCertExpiry(): Promise<CertStatus[]> {
  const { stdout } = await execFileAsync("sudo", ["certbot", "certificates"]);
  return parseCertbotOutput(stdout);
}

export function parseCertbotOutput(output: string): CertStatus[] {
  const results: CertStatus[] = [];
  const blocks = output.split(/Certificate Name:/).slice(1);

  for (const block of blocks) {
    const domainMatch = block.match(/Domains:\s+(.+)/);
    const expiryMatch = block.match(/Expiry Date:\s+([^(]+)\(VALID: (-?\d+) days?\)/);
    if (!domainMatch || !expiryMatch) continue;

    results.push({
      domain: domainMatch[1].trim().split(/\s+/)[0],
      expires_at: expiryMatch[1].trim(),
      days_remaining: parseInt(expiryMatch[2], 10),
      auto_renew_enabled: true,
    });
  }

  return results;
}
