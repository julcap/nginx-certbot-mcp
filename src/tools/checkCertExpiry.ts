import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CertStatus {
  domain: string;
  domains: string[]; // every name on the cert, e.g. ["example.com", "*.example.com"]
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

    const names = domainMatch[1].trim().split(/\s+/);
    results.push({
      domain: names[0],
      domains: names,
      expires_at: expiryMatch[1].trim(),
      days_remaining: parseInt(expiryMatch[2], 10),
      auto_renew_enabled: true,
    });
  }

  return results;
}

// A wildcard covers exactly one extra label: "*.example.com" covers
// "a.example.com" but neither "example.com" nor "a.b.example.com".
export function certCoversDomain(certDomains: string[], domain: string): boolean {
  const name = domain.toLowerCase();
  return certDomains.some((d) => {
    const cert = d.toLowerCase();
    if (cert === name) return true;
    if (!cert.startsWith("*.")) return false;
    const rest = name.slice(name.indexOf(".") + 1);
    return name.includes(".") && rest === cert.slice(2);
  });
}
