import { resolveCname, resolve4, resolve6 } from "node:dns/promises";

export interface DnsCheckResult {
  resolves: boolean;
  record_type?: "A" | "AAAA" | "CNAME";
  values?: string[];
}

export async function checkDomainResolution(domain: string): Promise<DnsCheckResult> {
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
