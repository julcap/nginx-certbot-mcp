#!/usr/bin/env node
// Safe, disposable integration test for the Route 53 tools: creates a
// throwaway CNAME record under a random subdomain, verifies it landed (both
// directly against Route 53 and, best-effort, via public DNS), then deletes
// it again - even if a check in between fails.
//
// The only requirement is AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
// ROUTE53_HOSTED_ZONE_ID in .env. It discovers the zone's own domain name
// from the hosted zone, so you don't need to already own or know a test
// subdomain - nothing touches nginx or certbot.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { GetHostedZoneCommand, ListResourceRecordSetsCommand } from "@aws-sdk/client-route-53";
import { getRoute53Config } from "../dist/route53.js";
import { createDomainRecord } from "../dist/tools/createDomainRecord.js";
import { deleteDomainRecord } from "../dist/tools/deleteDomainRecord.js";
import { checkDomainResolution } from "../dist/dns.js";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const config = getRoute53Config();
  if ("error" in config) {
    fail(config.error);
    return;
  }
  const { client, hostedZoneId } = config;

  const zone = await client.send(new GetHostedZoneCommand({ Id: hostedZoneId }));
  const zoneApex = zone.HostedZone?.Name?.replace(/\.$/, "");
  if (!zoneApex) {
    fail(`Could not read the hosted zone's domain name for ${hostedZoneId}.`);
    return;
  }

  const label = `mcp-test-${randomBytes(4).toString("hex")}`;
  const testDomain = `${label}.${zoneApex}`;
  console.log(`Zone: ${zoneApex}`);
  console.log(`Disposable test record: ${testDomain} -> ${zoneApex}\n`);

  let created = false;
  try {
    console.log("1. create_domain_record...");
    const createResult = await createDomainRecord({ domain: testDomain, target: zoneApex, ttl: 60 });
    if (!createResult.success) {
      fail(`create_domain_record: ${createResult.message}`);
      return;
    }
    created = true;
    console.log(`   ${createResult.message}\n`);

    console.log("2. Verifying directly against Route 53...");
    const list = await client.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        StartRecordName: testDomain,
        StartRecordType: "CNAME",
        MaxItems: 1,
      })
    );
    const record = list.ResourceRecordSets?.[0];
    const found = record?.Name?.replace(/\.$/, "") === testDomain && record.Type === "CNAME";
    if (!found) {
      fail("Record was not found in Route 53 immediately after creation.");
      return;
    }
    console.log(
      `   Found: ${record.Name} ${record.Type} TTL=${record.TTL} -> ` +
        `${record.ResourceRecords?.map((r) => r.Value).join(", ")}\n`
    );

    console.log("3. Best-effort public DNS resolution (up to 30s - propagation timing " +
      "is outside our control, so this never fails the test on its own)...");
    let resolved = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const dns = await checkDomainResolution(testDomain);
      if (dns.resolves) {
        console.log(`   Resolved as ${dns.record_type}: ${dns.values.join(", ")}`);
        resolved = true;
        break;
      }
      await sleep(5000);
    }
    if (!resolved) console.log("   Did not resolve publicly within 30s (not a failure - see note above).");

    console.log("\nPASS - create_domain_record and the Route 53 lookup both work.");
  } finally {
    if (created) {
      console.log("\n4. Cleaning up (delete_domain_record)...");
      const deleteResult = await deleteDomainRecord({ domain: testDomain, confirm: true });
      if (!deleteResult.success) {
        console.error(`   WARNING: cleanup failed - remove "${testDomain}" manually: ${deleteResult.message}`);
        process.exitCode = 1;
      } else {
        console.log(`   ${deleteResult.message}`);
      }
    }
  }
}

main().catch((err) => {
  fail(err.stack ?? String(err));
});
