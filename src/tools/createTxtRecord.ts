import { assertValidDnsRecordName } from "../validate.js";
import { getRoute53Config, upsertRecord } from "../route53.js";

export interface CreateTxtRecordInput {
  domain: string; // e.g. "_acme-challenge.mysite.julcap.net"
  value: string;
  ttl?: number;
}

export interface CreateTxtRecordResult {
  success: boolean;
  change_id?: string;
  change_status?: string;
  message: string;
}

// Route 53 TXT record values must be wrapped in double quotes - add them if
// the caller didn't, rather than failing with a confusing AWS error.
function quoteTxtValue(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value : `"${value.replace(/"/g, '\\"')}"`;
}

export async function createTxtRecord(
  input: CreateTxtRecordInput
): Promise<CreateTxtRecordResult> {
  const { domain, value, ttl = 300 } = input;

  assertValidDnsRecordName(domain);
  if (!value) throw new Error("TXT record value must not be empty");

  const config = getRoute53Config();
  if ("error" in config) {
    return { success: false, message: config.error };
  }

  return upsertRecord(config, domain, "TXT", [quoteTxtValue(value)], ttl);
}
