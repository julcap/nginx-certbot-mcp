import {
  Route53Client,
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
  type RRType,
} from "@aws-sdk/client-route-53";

export interface Route53Config {
  client: Route53Client;
  hostedZoneId: string;
}

// Shared by every tool that talks to Route 53 - fails closed with a single
// consistent message rather than letting each tool drift on its own wording.
export function getRoute53Config(): Route53Config | { error: string } {
  const hostedZoneId = process.env.ROUTE53_HOSTED_ZONE_ID;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!hostedZoneId || !accessKeyId || !secretAccessKey) {
    return {
      error:
        "Missing AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, or ROUTE53_HOSTED_ZONE_ID - " +
        "copy .env.example to .env and fill them in.",
    };
  }

  return {
    // Route 53 is a global service, but the SDK still requires a signing
    // region - default to us-east-1 (AWS's own recommendation for it)
    // rather than relying on an ambient AWS_REGION/~/.aws/config that won't
    // exist on a freshly provisioned box (or in the Docker sandbox).
    // AWS_DEFAULT_REGION lets that default be overridden if ever needed.
    client: new Route53Client({
      region: process.env.AWS_DEFAULT_REGION || "us-east-1",
      credentials: { accessKeyId, secretAccessKey },
    }),
    hostedZoneId,
  };
}

export interface UpsertRecordResult {
  success: boolean;
  change_id?: string;
  change_status?: string;
  message: string;
}

// Shared by create_domain_record (CNAME) and create_txt_record (TXT).
export async function upsertRecord(
  config: Route53Config,
  name: string,
  type: RRType,
  values: string[],
  ttl: number
): Promise<UpsertRecordResult> {
  const { client, hostedZoneId } = config;
  try {
    const result = await client.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          Comment: `nginx-certbot-mcp: UPSERT ${type} for ${name}`,
          Changes: [
            {
              // UPSERT (not CREATE) so re-pointing an existing record is
              // just as safe to call as creating a brand-new one.
              Action: "UPSERT",
              ResourceRecordSet: {
                Name: name,
                Type: type,
                TTL: ttl,
                ResourceRecords: values.map((Value) => ({ Value })),
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
      message: `UPSERT submitted: ${name} (${type}, TTL ${ttl}) -> ${values.join(", ")}.`,
    };
  } catch (err: any) {
    return { success: false, message: err.message ?? String(err) };
  }
}

export interface DeleteRecordResult {
  success: boolean;
  change_id?: string;
  change_status?: string;
  message: string;
}

// Shared by delete_domain_record (CNAME) and delete_txt_record (TXT) - DELETE
// requires the exact existing record (name, TTL, values), so look it up
// rather than guessing what was passed to the corresponding create tool.
export async function deleteRecord(
  config: Route53Config,
  name: string,
  type: RRType
): Promise<DeleteRecordResult> {
  const { client, hostedZoneId } = config;

  try {
    const listResult = await client.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        StartRecordName: name,
        StartRecordType: type,
        MaxItems: 1,
      })
    );

    // Route 53 normalizes record names with a trailing dot; compare loosely
    // against what the caller passed in.
    const record = listResult.ResourceRecordSets?.[0];
    if (!record || record.Type !== type || record.Name?.replace(/\.$/, "") !== name) {
      return {
        success: false,
        message: `No ${type} record found for "${name}" in this hosted zone - nothing to delete.`,
      };
    }

    const result = await client.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        ChangeBatch: {
          Comment: `nginx-certbot-mcp: DELETE ${type} for ${name}`,
          Changes: [{ Action: "DELETE", ResourceRecordSet: record }],
        },
      })
    );
    return {
      success: true,
      change_id: result.ChangeInfo?.Id,
      change_status: result.ChangeInfo?.Status,
      message: `DELETE submitted for "${name}".`,
    };
  } catch (err: any) {
    return { success: false, message: err.message ?? String(err) };
  }
}
