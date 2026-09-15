import { assertValidDomain } from "../validate.js";
import { getRoute53Config, upsertRecord } from "../route53.js";

export interface CreateDomainRecordInput {
  domain: string; // e.g. "mysite.julcap.net"
  target: string; // CNAME target, e.g. "www.julcap.net"
  ttl?: number;
}

export interface CreateDomainRecordResult {
  success: boolean;
  change_id?: string;
  change_status?: string;
  message: string;
}

export async function createDomainRecord(
  input: CreateDomainRecordInput
): Promise<CreateDomainRecordResult> {
  const { domain, target, ttl = 300 } = input;

  assertValidDomain(domain);
  assertValidDomain(target);

  const config = getRoute53Config();
  if ("error" in config) {
    return { success: false, message: config.error };
  }

  const result = await upsertRecord(config, domain, "CNAME", [target], ttl);
  if (!result.success) return result;
  return {
    ...result,
    message:
      `${result.message} DNS propagation can take a few minutes - issue_cert re-checks ` +
      `resolution before calling certbot, so it's safe to retry issue_cert if it reports ` +
      `the domain isn't resolving yet.`,
  };
}
