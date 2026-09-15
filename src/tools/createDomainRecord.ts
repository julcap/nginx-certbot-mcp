import { ChangeResourceRecordSetsCommand } from "@aws-sdk/client-route-53";
import { assertValidDomain } from "../validate.js";
import { getRoute53Config } from "../route53.js";

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
  const { client, hostedZoneId } = config;

  try {
    const result = await client.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          Comment: `nginx-certbot-mcp: UPSERT CNAME for ${domain}`,
          Changes: [
            {
              // UPSERT (not CREATE) so re-pointing an existing record is
              // just as safe to call as creating a brand-new one.
              Action: "UPSERT",
              ResourceRecordSet: {
                Name: domain,
                Type: "CNAME",
                TTL: ttl,
                ResourceRecords: [{ Value: target }],
              },
            },
          ],
        },
      })
    );
    return {
      success: true,
      change_id: result.ChangeInfo?.Id,
      change_status: result.ChangeInfo?.Status,
      message:
        `UPSERT submitted: ${domain} -> ${target} (TTL ${ttl}). DNS propagation can take a ` +
        `few minutes - issue_cert re-checks resolution before calling certbot, so it's safe ` +
        `to retry issue_cert if it reports the domain isn't resolving yet.`,
    };
  } catch (err: any) {
    return { success: false, message: err.message ?? String(err) };
  }
}
