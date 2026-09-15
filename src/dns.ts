import { Resolver } from "node:dns/promises";

export interface DnsCheckResult {
  resolves: boolean;
  record_type?: "A" | "AAAA" | "CNAME";
  values?: string[];
}

// Public resolvers, not this box's own /etc/resolv.conf - an ISP resolver,
// router stub, VPN split-DNS, or systemd-resolved can lag or behave
// differently, and what actually matters here is whether the domain
// resolves over the public DNS system, since that's what Let's Encrypt's
// own validation servers (and everyone else) will see.
const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];

export async function checkDomainResolution(domain: string): Promise<DnsCheckResult> {
  const resolver = new Resolver();
  resolver.setServers(PUBLIC_DNS_SERVERS);

  // Check CNAME first - if this domain is itself a CNAME (your usual
  // mysite.julcap.net -> www.julcap.net setup), report that hop explicitly
  // rather than silently following it through to the final A/AAAA record.
  try {
    const targets = await resolver.resolveCname(domain);
    return { resolves: true, record_type: "CNAME", values: targets };
  } catch {
    // Not a CNAME - fall through to checking A/AAAA directly.
  }

  try {
    const addresses = await resolver.resolve4(domain);
    return { resolves: true, record_type: "A", values: addresses };
  } catch {
    try {
      const addresses = await resolver.resolve6(domain);
      return { resolves: true, record_type: "AAAA", values: addresses };
    } catch {
      return { resolves: false };
    }
  }
}
