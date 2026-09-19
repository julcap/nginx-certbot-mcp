import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { listSites } from "./tools/listSites.js";
import { getSiteConfig } from "./tools/getSiteConfig.js";
import { checkCertExpiry } from "./tools/checkCertExpiry.js";
import { checkDns } from "./tools/checkDns.js";
import { checkUpstreamHealth } from "./tools/checkUpstreamHealth.js";
import { getNginxStatus } from "./tools/getNginxStatus.js";
import { tailSiteLogs } from "./tools/tailSiteLogs.js";
import { listArchivedSites } from "./tools/listArchivedSites.js";
import { createDomainRecord } from "./tools/createDomainRecord.js";
import { deleteDomainRecord } from "./tools/deleteDomainRecord.js";
import { createTxtRecord } from "./tools/createTxtRecord.js";
import { deleteTxtRecord } from "./tools/deleteTxtRecord.js";
import { createSite } from "./tools/createSite.js";
import { updateSite } from "./tools/updateSite.js";
import { deleteSite } from "./tools/deleteSite.js";
import { restoreSite } from "./tools/restoreSite.js";
import { rollbackSite } from "./tools/rollbackSite.js";
import { listSiteBackups } from "./backups.js";
import { pruneArchives } from "./tools/pruneArchives.js";
import { reloadNginx } from "./tools/reloadNginx.js";
import { issueCert } from "./tools/issueCert.js";
import { issueWildcardCert } from "./tools/issueWildcardCert.js";
import { renewCert } from "./tools/renewCert.js";
import { revokeCert } from "./tools/revokeCert.js";
import { deleteCert } from "./tools/deleteCert.js";
import { MAX_LOG_LINES } from "./config.js";
import { AuditLogger, resolveAuditPath } from "./audit.js";
import { createRegistrar } from "./guard.js";
import { domainFilter, loadPolicy } from "./policy.js";

const server = new McpServer({
  name: "nginx-certbot-mcp",
  version: "0.1.0",
});

const audit = new AuditLogger(resolveAuditPath(), process.env.AUDIT_LOG_READS === "true");
let policy;
try {
  policy = loadPolicy();
  await audit.init();
} catch (err: any) {
  console.error(err.message);
  process.exit(1);
}

// All tools register through this so auditing (and policy) apply uniformly.
const { registerTool, summary } = createRegistrar(server, {
  audit,
  policy,
  getClient: () => {
    const client = server.server.getClientVersion();
    return client ? `${client.name}/${client.version}` : undefined;
  },
});

// Shared fragments so the DNS-check result shape isn't repeated across every
// tool whose output can embed one (issue_cert, check_dns).
const dnsCheckResultShape = {
  resolves: z.boolean(),
  record_type: z.enum(["A", "AAAA", "CNAME"]).optional().describe("Only present when resolves is true"),
  values: z.array(z.string()).optional().describe("Resolved values (IPs, or the CNAME target); only present when resolves is true"),
};

const route53ChangeResultShape = {
  success: z.boolean(),
  change_id: z.string().optional().describe("Route 53 change ID, useful for polling propagation status"),
  change_status: z.string().optional().describe("Route 53 change status, e.g. PENDING or INSYNC"),
  message: z.string(),
};

// --- Read-only tools ---

registerTool(
  "list_sites",
  {
    description:
      "List every nginx server block currently in sites-enabled, with domain, upstream, and " +
      "whether SSL looks configured. Read-only - parses config files directly, does not shell " +
      "out to nginx. Use get_site_config for one domain's full raw config.",
    inputSchema: {},
    outputSchema: {
      sites: z.array(
        z.object({
          domain: z.string().describe("server_name parsed from the config, or the filename if not found"),
          config_path: z.string().describe("Absolute path to the enabled config file"),
          upstream: z.string().nullable().describe("proxy_pass target, or null if none was found"),
          ssl_enabled: z.boolean().describe("True if the config listens on 443 ssl or sets ssl_certificate"),
        })
      ),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const inScope = domainFilter(policy);
    const sites = (await listSites()).filter((s) => s.domain.split(/\s+/).every(inScope));
    return {
      content: [{ type: "text", text: JSON.stringify(sites, null, 2) }],
      structuredContent: { sites },
    };
  }
);

registerTool(
  "get_site_config",
  {
    description:
      "Get the raw, unparsed nginx config file for one domain from sites-available. Throws if " +
      "no config exists for that domain - call list_sites first if you're not sure it exists.",
    inputSchema: {
      domain: z.string().describe("Domain as it appears in sites-available, e.g. mysite.julcap.net"),
    },
    outputSchema: {
      domain: z.string(),
      raw_config: z.string().describe("Full contents of the nginx config file, verbatim"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ domain }) => {
    const result = await getSiteConfig(domain);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "check_cert_expiry",
  {
    description:
      "List every certbot-managed certificate on the box with its expiry date and days " +
      "remaining, via `certbot certificates`. Read-only. Covers all certs certbot knows about, " +
      "not just domains with an active nginx site.",
    inputSchema: {},
    outputSchema: {
      certificates: z.array(
        z.object({
          domain: z.string(),
          expires_at: z.string().describe("Expiry date/time as reported by certbot"),
          days_remaining: z.number().int().describe("Negative if the certificate has already expired"),
          auto_renew_enabled: z.boolean(),
        })
      ),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const certs = (await checkCertExpiry()).filter((c) => domainFilter(policy)(c.domain));
    return {
      content: [{ type: "text", text: JSON.stringify(certs, null, 2) }],
      structuredContent: { certificates: certs },
    };
  }
);

registerTool(
  "check_dns",
  {
    description:
      "Resolve a domain (CNAME first, then A/AAAA) against public resolvers (1.1.1.1, 8.8.8.8) " +
      "rather than this box's own DNS, so the result matches what Let's Encrypt and the public " +
      "internet see. Use before issue_cert / create_site to confirm a domain actually points " +
      "where you expect. For confirming something is listening behind nginx, use " +
      "check_upstream_health instead.",
    inputSchema: {
      domain: z.string().describe("Domain to resolve, e.g. mysite.julcap.net"),
    },
    outputSchema: dnsCheckResultShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ domain }) => {
    const result = await checkDns(domain);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "check_upstream_health",
  {
    description:
      "TCP-probe an upstream host:port to confirm something is actually listening there, " +
      "independent of nginx or DNS. Use to sanity-check an upstream before create_site, or to " +
      "debug a 502 afterward. For confirming a public domain resolves, use check_dns instead.",
    inputSchema: {
      upstream_host: z.string().describe("Hostname or IP that nginx would proxy_pass to"),
      upstream_port: z.number().int().min(1).max(65535).describe("TCP port to probe"),
      timeout_ms: z.number().int().min(1).default(3000).describe("Milliseconds to wait before reporting unreachable"),
    },
    outputSchema: {
      reachable: z.boolean(),
      message: z.string().describe("Human-readable outcome, e.g. success, timeout, or connection error detail"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ upstream_host, upstream_port, timeout_ms }) => {
    const result = await checkUpstreamHealth({ upstream_host, upstream_port, timeout_ms });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "get_nginx_status",
  {
    description: "Report whether the nginx service is active (via systemctl) and its version string. Read-only.",
    inputSchema: {},
    outputSchema: {
      running: z.boolean(),
      version: z.string().describe("`nginx -v` output, or an explanatory message if it couldn't be determined"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const result = await getNginxStatus();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "tail_site_logs",
  {
    description:
      "Tail nginx's access or error log (capped at 1000 lines). `domain` is a best-effort " +
      "substring filter, not a true per-vhost filter - see the result's `note`.",
    inputSchema: {
      log_type: z.enum(["access", "error"]).describe("Which nginx log to read"),
      lines: z.number().int().min(1).default(100).describe(`Most recent lines to return, capped at ${MAX_LOG_LINES}`),
      domain: z
        .string()
        .optional()
        .describe("Best-effort substring filter over each log line - see the result's `note` for its limits"),
    },
    outputSchema: {
      success: z.boolean(),
      lines: z.array(z.string()),
      note: z.string().optional().describe("Present when a domain filter was applied, or when the read failed"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ log_type, lines, domain }) => {
    const result = await tailSiteLogs({ log_type, lines, domain });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "list_archived_sites",
  {
    description:
      "List archived nginx configs created by delete_site, newest first. Feed a filename from " +
      "here into restore_site's archive_filename to restore a specific archive instead of the newest.",
    inputSchema: { domain: z.string().optional().describe("Filter to one domain's archives") },
    outputSchema: {
      archives: z.array(
        z.object({
          domain: z.string(),
          filename: z.string().describe("Pass this to restore_site's archive_filename to pick this archive"),
          archived_at: z.string().describe("YYYY-MM-DD HH:MM:SS, server-local time"),
        })
      ),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ domain }) => {
    const result = (await listArchivedSites(domain)).filter((a) => domainFilter(policy)(a.domain));
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: { archives: result },
    };
  }
);

registerTool(
  "list_site_backups",
  {
    description:
      "List the automatic backups of site configs, newest first. A backup is taken of the " +
      "existing config just before create_site, update_site, restore_site or rollback_site " +
      "changes it (the newest 10 per domain are kept). Feed a filename from here into " +
      "rollback_site's backup_filename to return to a specific version instead of the newest. " +
      "Not the same as list_archived_sites, which holds configs removed by delete_site.",
    inputSchema: { domain: z.string().optional().describe("Filter to one domain's backups") },
    outputSchema: {
      backups: z.array(
        z.object({
          domain: z.string(),
          filename: z.string().describe("Pass this to rollback_site's backup_filename to pick this backup"),
          backed_up_at: z.string().describe("YYYY-MM-DD HH:MM:SS, server-local time"),
        })
      ),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ domain }) => {
    const result = (await listSiteBackups(domain)).filter((b) => domainFilter(policy)(b.domain));
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: { backups: result },
    };
  }
);

// --- DNS (Route 53) ---

registerTool(
  "create_domain_record",
  {
    description:
      "Upsert a Route 53 CNAME record pointing `domain` at `target`. Safe to call repeatedly - " +
      "it's an upsert, not create-only. Run this before create_site / issue_cert and allow a " +
      "few minutes for DNS propagation; issue_cert re-checks resolution itself, so it's safe to " +
      "retry issue_cert if it reports the domain isn't resolving yet. For an ACME DNS-01 TXT " +
      "challenge record, use create_txt_record instead.",
    inputSchema: {
      domain: z.string().describe("The domain to create/update, e.g. mysite.julcap.net"),
      target: z.string().describe("CNAME target the domain should point to, e.g. www.julcap.net"),
      ttl: z.number().int().min(1).default(300).describe("DNS TTL in seconds"),
    },
    outputSchema: route53ChangeResultShape,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ domain, target, ttl }) => {
    const result = await createDomainRecord({ domain, target, ttl });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "delete_domain_record",
  {
    description:
      "Delete the Route 53 CNAME record for a domain. Destructive - requires confirm:true " +
      "to actually act; without it, returns what would happen and changes nothing. Looks up the " +
      "exact existing record first rather than guessing its TTL/value.",
    inputSchema: {
      domain: z.string().describe("The domain whose CNAME record should be deleted"),
      confirm: z.boolean().default(false).describe("Must be true to actually delete; false (default) is a dry run"),
    },
    outputSchema: route53ChangeResultShape,
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ domain, confirm }) => {
    const result = await deleteDomainRecord({ domain, confirm });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "create_txt_record",
  {
    description:
      "Upsert a Route 53 TXT record - e.g. for an ACME DNS-01 challenge " +
      "(_acme-challenge.<domain>, as used by issue_wildcard_cert) or domain verification. " +
      "Quotes the value automatically if the caller didn't. Clean up afterward with " +
      "delete_txt_record. For a CNAME pointing a domain at an upstream, use create_domain_record " +
      "instead.",
    inputSchema: {
      domain: z.string().describe("Record name, e.g. _acme-challenge.mysite.julcap.net"),
      value: z.string().describe("TXT record value; wrapped in double quotes automatically if not already"),
      ttl: z.number().int().min(1).default(300).describe("DNS TTL in seconds"),
    },
    outputSchema: route53ChangeResultShape,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ domain, value, ttl }) => {
    const result = await createTxtRecord({ domain, value, ttl });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "delete_txt_record",
  {
    description:
      "Delete the Route 53 TXT record for a domain - e.g. to clean up an ACME DNS-01 challenge " +
      "record left behind by create_txt_record or issue_wildcard_cert. Destructive - requires " +
      "confirm:true to actually act; without it, returns what would happen and changes nothing. " +
      "Looks up the exact existing record first rather than guessing its TTL/value. For a CNAME " +
      "record, use delete_domain_record instead.",
    inputSchema: {
      domain: z.string().describe("Record name whose TXT record should be deleted, e.g. _acme-challenge.mysite.julcap.net"),
      confirm: z.boolean().default(false).describe("Must be true to actually delete; false (default) is a dry run"),
    },
    outputSchema: route53ChangeResultShape,
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ domain, confirm }) => {
    const result = await deleteTxtRecord({ domain, confirm });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

// --- Site lifecycle ---

registerTool(
  "create_site",
  {
    description:
      "Create a new nginx server block from the websocket-capable default template. " +
      "Validates and test-renders (`nginx -t`) before touching live config, and rolls back " +
      "automatically if the test fails. Does NOT reload nginx or request a certificate - follow " +
      "with reload_nginx to go live, then issue_cert to get SSL. To point an existing site at a " +
      "different upstream later, use update_site instead of recreating it. If a config for the " +
      "domain already exists it is replaced - after being backed up (see rollback_site).",
    inputSchema: {
      domain: z.string().describe("Domain for the new server block, e.g. mysite.julcap.net"),
      upstream_host: z.string().describe("Hostname or IP nginx should proxy_pass to"),
      upstream_port: z.number().int().min(1).max(65535).describe("TCP port on the upstream host"),
    },
    outputSchema: {
      success: z.boolean(),
      config_path: z.string().optional().describe("Present on success: absolute path of the written config"),
      test_output: z.string().describe("Output of `nginx -t` against the rendered config"),
      reload_required: z.boolean().describe("True on success - nginx has not actually been reloaded yet"),
      backup_created: z.boolean().optional().describe("True if an existing config was replaced; it was backed up first (see rollback_site)"),
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async ({ domain, upstream_host, upstream_port }) => {
    const result = await createSite({ domain, upstream_host, upstream_port });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "update_site",
  {
    description:
      "Update an existing site's upstream by rewriting its proxy_pass directive(s) in place - " +
      "everything else in the config, including any SSL server block issue_cert/certbot added, " +
      "is left untouched. Fails if the domain has no existing config (use create_site instead) " +
      "or has no proxy_pass directive to update. Test-renders before keeping the change and " +
      "rolls back automatically if `nginx -t` fails. The previous config is backed up first, so " +
      "a bad-but-valid change can be undone later with rollback_site. Does NOT reload nginx - " +
      "call reload_nginx afterward.",
    inputSchema: {
      domain: z.string().describe("Domain of the existing site to update"),
      upstream_host: z.string().describe("New hostname or IP nginx should proxy_pass to"),
      upstream_port: z.number().int().min(1).max(65535).describe("New TCP port on the upstream host"),
    },
    outputSchema: {
      success: z.boolean(),
      test_output: z.string().describe("Output of `nginx -t` against the rewritten config, or an explanatory message if nothing was changed"),
      reload_required: z.boolean().describe("True on success - nginx has not actually been reloaded yet"),
      backup_created: z.boolean().optional().describe("True once the previous config was backed up; undo with rollback_site"),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ domain, upstream_host, upstream_port }) => {
    const result = await updateSite({ domain, upstream_host, upstream_port });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "delete_site",
  {
    description:
      "Disable, archive, and delete the nginx server block for a domain. Destructive - " +
      "requires confirm:true to actually act; without it, returns what would happen. " +
      "Does not touch any certbot certificate for the domain. Does NOT reload nginx - call " +
      "reload_nginx afterward. The archived copy can be brought back with restore_site.",
    inputSchema: {
      domain: z.string().describe("Domain whose server block should be removed"),
      confirm: z.boolean().default(false).describe("Must be true to actually act; false (default) is a dry run"),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
      reload_required: z.boolean().describe("True on success - nginx has not actually been reloaded yet"),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ domain, confirm }) => {
    const result = await deleteSite({ domain, confirm });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "restore_site",
  {
    description:
      "Restore a domain's nginx config from its most recent archive (created by delete_site) " +
      "and enable it. Destructive to any current config for that domain (which is backed up " +
      "first, see rollback_site) - requires confirm:true. " +
      "Test-renders before enabling and rolls back automatically if that fails. Does NOT reload " +
      "nginx - call reload_nginx afterward.",
    inputSchema: {
      domain: z.string().describe("Domain to restore"),
      confirm: z.boolean().default(false).describe("Must be true to actually act; false (default) is a dry run"),
      archive_filename: z
        .string()
        .optional()
        .describe("A filename from list_archived_sites; defaults to the newest archive for this domain"),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
      reload_required: z.boolean().describe("True on success - nginx has not actually been reloaded yet"),
    },
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ domain, confirm, archive_filename }) => {
    const result = await restoreSite({ domain, confirm, archive_filename });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "rollback_site",
  {
    description:
      "Undo a config change: replace a site's current nginx config with a backup taken by " +
      "create_site, update_site, restore_site or a previous rollback_site (see list_site_backups). " +
      "Defaults to the newest backup, i.e. the config as it was before the last change. The " +
      "current config is backed up first, so calling this again flips back. Requires confirm:true. " +
      "Test-renders before keeping the result and leaves the current config in place if `nginx -t` " +
      "fails. Does NOT reload nginx - call reload_nginx afterward.",
    inputSchema: {
      domain: z.string().describe("Domain whose config should be rolled back"),
      confirm: z.boolean().default(false).describe("Must be true to actually act; false (default) is a dry run"),
      backup_filename: z
        .string()
        .optional()
        .describe("A filename from list_site_backups; defaults to the newest backup for this domain"),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
      reload_required: z.boolean().describe("True on success - nginx has not actually been reloaded yet"),
    },
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ domain, confirm, backup_filename }) => {
    const result = await rollbackSite({ domain, confirm, backup_filename });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "prune_archives",
  {
    description:
      "Delete archived site configs (from delete_site) older than a threshold. Destructive - " +
      "requires confirm:true to actually act; without it, lists what would be deleted and " +
      "changes nothing. Continues past individual failures and reports how many actually got removed.",
    inputSchema: {
      older_than_days: z.number().int().min(1).default(30).describe("Age threshold in days"),
      confirm: z.boolean().default(false).describe("Must be true to actually delete; false (default) is a dry run"),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
      pruned: z.array(z.string()).describe("Archive filenames removed - or, when confirm is false, that would be removed"),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ older_than_days, confirm }) => {
    const result = await pruneArchives({ older_than_days, confirm, isAllowed: domainFilter(policy) });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

// --- Nginx ---

registerTool(
  "reload_nginx",
  {
    description:
      "Run `nginx -t` and reload the live service only if the config test passes - never " +
      "reloads a broken config. Call this after create_site, delete_site, or restore_site to " +
      "apply the change; those tools do not reload automatically.",
    inputSchema: {},
    outputSchema: {
      success: z.boolean(),
      test_output: z.string().describe("Combined stdout/stderr of `nginx -t`"),
      hint: z.string().optional().describe("Present on failure: how to recover, e.g. via rollback_site"),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const result = await reloadNginx();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

// --- Certificate lifecycle ---

registerTool(
  "issue_cert",
  {
    description:
      "Request a certificate via `certbot --nginx` (HTTP-01 validation). Requires an nginx " +
      "server block for `domain` to already exist (create_site) - certbot's nginx plugin edits " +
      "that existing sites-available config in place, adding an SSL server block and an " +
      "HTTP->HTTPS redirect; it does not create a new site from scratch, and it reloads nginx " +
      "itself on success (no separate reload_nginx call needed). Pre-checks that the domain " +
      "resolves and fails fast with guidance if not, avoiding a wasted attempt against Let's " +
      "Encrypt's rate limits. Defaults to Let's Encrypt staging, which issues browser-untrusted " +
      "certs but is exempt from rate limits - pass staging:false only when you're ready for a " +
      "real, publicly CT-logged certificate: production Let's Encrypt enforces real per-domain " +
      "issuance rate limits (a handful of certs per week), and a mis-issued cert isn't silently " +
      "undone - call revoke_cert if you need to invalidate one. A local guard also refuses " +
      "production requests that would exceed Let's Encrypt's duplicate-certificate, " +
      "failed-validation or per-domain limits, reporting when to retry. For a *.domain wildcard, use " +
      "issue_wildcard_cert instead - HTTP-01 can't validate wildcards.",
    inputSchema: {
      domain: z
        .string()
        .describe(
          "Domain to request a certificate for. Must already resolve (see check_dns) and " +
            "already have an nginx server block from create_site - certbot edits that existing " +
            "config rather than creating one."
        ),
      staging: z
        .boolean()
        .default(true)
        .describe(
          "True (default) uses Let's Encrypt's staging CA - browser-untrusted certs, but exempt " +
            "from production rate limits; use for testing the flow. False requests a real, " +
            "browser-trusted cert and counts against production rate limits."
        ),
      email: z
        .string()
        .optional()
        .describe(
          "Contact email registered with the Let's Encrypt account, used for renewal-failure " +
            "and expiry notices. Omitted registers with --register-unsafely-without-email, so " +
            "Let's Encrypt cannot warn you if a future automated renewal fails."
        ),
    },
    outputSchema: {
      success: z.boolean(),
      certbot_output: z.string().describe("Raw combined stdout/stderr from the certbot CLI invocation, on success or failure"),
      dns_check: z.object(dnsCheckResultShape).optional().describe("Present only when the DNS pre-check failed, before certbot was even invoked"),
      rate_limit_note: z
        .string()
        .optional()
        .describe(
          "Set when the local rate-limit guard refused a production request (with when to retry), " +
            "or when a Let's Encrypt production limit is close"
        ),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  async ({ domain, staging, email }) => {
    const result = await issueCert({ domain, staging, email });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "issue_wildcard_cert",
  {
    description:
      "Request a wildcard certificate (`domain` and `*.domain`) via `certbot --dns-route53` " +
      "(DNS-01 validation, required since HTTP-01 can't prove ownership of a wildcard). " +
      "Requires the certbot-dns-route53 plugin installed on the box and AWS credentials in the " +
      "environment (see README) - fails fast with guidance if credentials are missing. Defaults " +
      "to staging; a local guard refuses production requests that would exceed Let's Encrypt's " +
      "rate limits, reporting when to retry. For a single non-wildcard domain, use issue_cert instead.",
    inputSchema: {
      domain: z.string().describe("Base domain, e.g. julcap.net - issues it plus *.julcap.net"),
      staging: z
        .boolean()
        .default(true)
        .describe("True (default) uses Let's Encrypt's staging CA: untrusted certs, but no rate-limit risk"),
      email: z.string().optional().describe("Contact email for the Let's Encrypt account; omitted registers unsafely-without-email"),
    },
    outputSchema: {
      success: z.boolean(),
      certbot_output: z.string(),
      rate_limit_note: z
        .string()
        .optional()
        .describe(
          "Set when the local rate-limit guard refused a production request (with when to retry), " +
            "or when a Let's Encrypt production limit is close"
        ),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  async ({ domain, staging, email }) => {
    const result = await issueWildcardCert({ domain, staging, email });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "renew_cert",
  {
    description:
      "Run `certbot renew`, optionally scoped to one cert via --cert-name. Defaults to " +
      "--dry-run (simulates against Let's Encrypt staging without touching the live cert or " +
      "rate limit) - pass dry_run:false only when you mean to actually renew. Always disables " +
      "certbot's random pre-renewal sleep so the call returns synchronously.",
    inputSchema: {
      domain: z.string().optional().describe("Cert name to renew; omit to renew everything due"),
      dry_run: z.boolean().default(true).describe("True (default) simulates the renewal without touching the live cert"),
    },
    outputSchema: {
      success: z.boolean(),
      certbot_output: z.string(),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  async ({ domain, dry_run }) => {
    const result = await renewCert({ domain, dry_run });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "revoke_cert",
  {
    description:
      "Revoke a certificate with Let's Encrypt (e.g. after a key compromise) - the CA " +
      "distrusts it immediately, browser-wide, for any site still serving it. Destructive and " +
      "effectively irreversible - requires confirm:true. Leaves the cert files on disk; follow " +
      "with delete_cert to remove them.",
    inputSchema: {
      domain: z.string().describe("certbot cert name"),
      confirm: z.boolean().default(false).describe("Must be true to actually revoke; false (default) is a dry run"),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ domain, confirm }) => {
    const result = await revokeCert({ domain, confirm });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

registerTool(
  "delete_cert",
  {
    description:
      "Delete a certificate's files from certbot's local store. Destructive - requires " +
      "confirm:true. Does not revoke the certificate first - if it may be compromised, call " +
      "revoke_cert before this. Any nginx config still referencing the deleted files will fail " +
      "to reload afterward.",
    inputSchema: {
      domain: z.string().describe("certbot cert name"),
      confirm: z.boolean().default(false).describe("Must be true to actually delete; false (default) is a dry run"),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ domain, confirm }) => {
    const result = await deleteCert({ domain, confirm });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  }
);

// stdout is the MCP protocol channel - operator-facing notices go to stderr.
const { registered, skipped, warnings } = summary();
console.error(
  `[nginx-certbot-mcp] mode=${policy.mode}, ${registered.length} of ${registered.length + skipped.length} tools enabled` +
    (audit.enabled ? `, audit log: ${audit.path}` : ", audit log: off")
);
for (const warning of warnings) console.error(`[nginx-certbot-mcp] warning: ${warning}`);

const transport = new StdioServerTransport();
await server.connect(transport);
