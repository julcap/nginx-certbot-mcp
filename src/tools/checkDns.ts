import { assertValidDomain } from "../validate.js";
import { checkDomainResolution, type DnsCheckResult } from "../dns.js";

export async function checkDns(domain: string): Promise<DnsCheckResult> {
  assertValidDomain(domain);
  return checkDomainResolution(domain);
}
