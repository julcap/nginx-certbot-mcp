import { assertValidDnsRecordName } from "../validate.js";
import { getRoute53Config, deleteRecord } from "../route53.js";

export interface DeleteTxtRecordInput {
  domain: string;
  confirm: boolean;
}

export interface DeleteTxtRecordResult {
  success: boolean;
  change_id?: string;
  change_status?: string;
  message: string;
}

export async function deleteTxtRecord(input: DeleteTxtRecordInput): Promise<DeleteTxtRecordResult> {
  const { domain, confirm } = input;
  assertValidDnsRecordName(domain);

  // Destructive - no side effects until the caller explicitly confirms.
  if (!confirm) {
    return {
      success: false,
      message:
        `This will delete the Route 53 TXT record for "${domain}" - e.g. an ACME DNS-01 ` +
        `challenge or a domain verification record. Call again with confirm:true to proceed.`,
    };
  }

  const config = getRoute53Config();
  if ("error" in config) {
    return { success: false, message: config.error };
  }

  return deleteRecord(config, domain, "TXT");
}
