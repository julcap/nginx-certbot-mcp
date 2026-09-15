import { ChangeResourceRecordSetsCommand, ListResourceRecordSetsCommand } from "@aws-sdk/client-route-53";
import { assertValidDomain } from "../validate.js";
import { getRoute53Config } from "../route53.js";

export interface DeleteDomainRecordInput {
  domain: string;
  confirm: boolean;
}

export interface DeleteDomainRecordResult {
  success: boolean;
  change_id?: string;
  change_status?: string;
  message: string;
}

// Route 53 normalizes record names with a trailing dot; compare loosely
// against what the caller passed in.
function matchesDomain(recordName: string | undefined, domain: string): boolean {
  return recordName?.replace(/\.$/, "") === domain;
}

export async function deleteDomainRecord(
  input: DeleteDomainRecordInput
): Promise<DeleteDomainRecordResult> {
  const { domain, confirm } = input;
  assertValidDomain(domain);

  // Destructive - no side effects until the caller explicitly confirms.
  if (!confirm) {
    return {
      success: false,
      message:
        `This will delete the Route 53 CNAME record for "${domain}" - anything still ` +
        `pointing traffic at it will stop resolving. Call again with confirm:true to proceed.`,
    };
  }

  const config = getRoute53Config();
  if ("error" in config) {
    return { success: false, message: config.error };
  }
  const { client, hostedZoneId } = config;

  try {
    // DELETE requires the exact existing record (name, type, TTL, values) -
    // look it up rather than guessing what was passed to create_domain_record.
    const listResult = await client.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        StartRecordName: domain,
        StartRecordType: "CNAME",
        MaxItems: 1,
      })
    );

    const record = listResult.ResourceRecordSets?.[0];
    if (!record || record.Type !== "CNAME" || !matchesDomain(record.Name, domain)) {
      return {
        success: false,
        message: `No CNAME record found for "${domain}" in this hosted zone - nothing to delete.`,
      };
    }

    const result = await client.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          Comment: `nginx-certbot-mcp: DELETE CNAME for ${domain}`,
          Changes: [{ Action: "DELETE", ResourceRecordSet: record }],
        },
      })
    );
    return {
      success: true,
      change_id: result.ChangeInfo?.Id,
      change_status: result.ChangeInfo?.Status,
      message: `DELETE submitted for "${domain}".`,
    };
  } catch (err: any) {
    return { success: false, message: err.message ?? String(err) };
  }
}
