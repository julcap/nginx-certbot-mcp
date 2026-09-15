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
import { createSite } from "./tools/createSite.js";
import { deleteSite } from "./tools/deleteSite.js";
import { restoreSite } from "./tools/restoreSite.js";
import { pruneArchives } from "./tools/pruneArchives.js";
import { reloadNginx } from "./tools/reloadNginx.js";
import { issueCert } from "./tools/issueCert.js";
import { issueWildcardCert } from "./tools/issueWildcardCert.js";
import { renewCert } from "./tools/renewCert.js";
import { revokeCert } from "./tools/revokeCert.js";
import { deleteCert } from "./tools/deleteCert.js";

const server = new McpServer({
  name: "nginx-certbot-mcp",
  version: "0.1.0",
});

// --- Read-only tools ---

server.registerTool(
  "list_sites",
  {
    description: "List all configured nginx server blocks with domain, upstream, and SSL status.",
    inputSchema: {},
  },
  async () => {
    const sites = await listSites();
    return { content: [{ type: "text", text: JSON.stringify(sites, null, 2) }] };
  }
);

server.registerTool(
  "get_site_config",
  {
    description: "Get the raw nginx config for a specific domain.",
    inputSchema: { domain: z.string().describe("The domain to look up, e.g. my.domain.com") },
  },
  async ({ domain }) => {
    const result = await getSiteConfig(domain);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "check_cert_expiry",
  {
    description: "List certbot-managed certificates and days until expiry.",
    inputSchema: {},
  },
  async () => {
    const certs = await checkCertExpiry();
    return { content: [{ type: "text", text: JSON.stringify(certs, null, 2) }] };
  }
);

server.registerTool(
  "check_dns",
  {
    description: "Resolve a domain (CNAME, then A/AAAA) and report what it currently points to.",
    inputSchema: { domain: z.string() },
  },
  async ({ domain }) => {
    const result = await checkDns(domain);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "check_upstream_health",
  {
    description: "TCP-probe an upstream host:port to confirm something is actually listening there.",
    inputSchema: {
      upstream_host: z.string(),
      upstream_port: z.number().int().min(1).max(65535),
      timeout_ms: z.number().int().min(1).default(3000),
    },
  },
  async ({ upstream_host, upstream_port, timeout_ms }) => {
    const result = await checkUpstreamHealth({ upstream_host, upstream_port, timeout_ms });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "get_nginx_status",
  {
    description: "Report whether the nginx service is running and its version.",
    inputSchema: {},
  },
  async () => {
    const result = await getNginxStatus();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "tail_site_logs",
  {
    description:
      "Tail nginx's access or error log (capped at 1000 lines). `domain` is a best-effort " +
      "substring filter, not a true per-vhost filter - see the result's `note`.",
    inputSchema: {
      log_type: z.enum(["access", "error"]),
      lines: z.number().int().min(1).default(100),
      domain: z.string().optional(),
    },
  },
  async ({ log_type, lines, domain }) => {
    const result = await tailSiteLogs({ log_type, lines, domain });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "list_archived_sites",
  {
    description: "List archived nginx configs (created by delete_site), newest first.",
    inputSchema: { domain: z.string().optional().describe("Filter to one domain's archives") },
  },
  async ({ domain }) => {
    const result = await listArchivedSites(domain);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- DNS (Route 53) ---

server.registerTool(
  "create_domain_record",
  {
    description:
      "Upsert a Route 53 CNAME record pointing `domain` at `target`. " +
      "Run this before create_site / issue_cert and wait for DNS propagation.",
    inputSchema: {
      domain: z.string().describe("The domain to create/update, e.g. mysite.julcap.net"),
      target: z.string().describe("CNAME target the domain should point to, e.g. www.julcap.net"),
      ttl: z.number().int().min(1).default(300),
    },
  },
  async ({ domain, target, ttl }) => {
    const result = await createDomainRecord({ domain, target, ttl });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "delete_domain_record",
  {
    description:
      "Delete the Route 53 CNAME record for a domain. Destructive - requires confirm:true " +
      "to actually act; without it, returns what would happen.",
    inputSchema: {
      domain: z.string(),
      confirm: z.boolean().default(false),
    },
  },
  async ({ domain, confirm }) => {
    const result = await deleteDomainRecord({ domain, confirm });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "create_txt_record",
  {
    description:
      "Upsert a Route 53 TXT record - e.g. for an ACME DNS-01 challenge " +
      "(_acme-challenge.<domain>) or domain verification. Quotes the value automatically.",
    inputSchema: {
      domain: z.string().describe("Record name, e.g. _acme-challenge.mysite.julcap.net"),
      value: z.string(),
      ttl: z.number().int().min(1).default(300),
    },
  },
  async ({ domain, value, ttl }) => {
    const result = await createTxtRecord({ domain, value, ttl });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Site lifecycle ---

server.registerTool(
  "create_site",
  {
    description:
      "Create a new nginx server block from the websocket-capable default template. " +
      "Validates and test-renders before touching live config.",
    inputSchema: {
      domain: z.string(),
      upstream_host: z.string(),
      upstream_port: z.number().int().min(1).max(65535),
    },
  },
  async ({ domain, upstream_host, upstream_port }) => {
    const result = await createSite({ domain, upstream_host, upstream_port });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "delete_site",
  {
    description:
      "Disable, archive, and delete the nginx server block for a domain. Destructive - " +
      "requires confirm:true to actually act; without it, returns what would happen. " +
      "Does not touch any certbot certificate for the domain.",
    inputSchema: {
      domain: z.string(),
      confirm: z.boolean().default(false),
    },
  },
  async ({ domain, confirm }) => {
    const result = await deleteSite({ domain, confirm });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "restore_site",
  {
    description:
      "Restore a domain's nginx config from its most recent archive (created by delete_site) " +
      "and enable it. Destructive to any current config for that domain - requires confirm:true.",
    inputSchema: {
      domain: z.string(),
      confirm: z.boolean().default(false),
      archive_filename: z.string().optional().describe("Pick a specific archive instead of the newest"),
    },
  },
  async ({ domain, confirm, archive_filename }) => {
    const result = await restoreSite({ domain, confirm, archive_filename });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "prune_archives",
  {
    description:
      "Delete archived site configs older than a threshold. Destructive - requires " +
      "confirm:true to actually act; without it, lists what would be deleted.",
    inputSchema: {
      older_than_days: z.number().int().min(1).default(30),
      confirm: z.boolean().default(false),
    },
  },
  async ({ older_than_days, confirm }) => {
    const result = await pruneArchives({ older_than_days, confirm });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Nginx ---

server.registerTool(
  "reload_nginx",
  {
    description: "Run `nginx -t` and reload only if the config test passes.",
    inputSchema: {},
  },
  async () => {
    const result = await reloadNginx();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Certificate lifecycle ---

server.registerTool(
  "issue_cert",
  {
    description:
      "Request a certificate via `certbot --nginx`. Defaults to Let's Encrypt staging - " +
      "pass staging:false only when you mean it.",
    inputSchema: {
      domain: z.string(),
      staging: z.boolean().default(true),
      email: z.string().optional(),
    },
  },
  async ({ domain, staging, email }) => {
    const result = await issueCert({ domain, staging, email });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "issue_wildcard_cert",
  {
    description:
      "Request a wildcard certificate (`domain` and `*.domain`) via `certbot --dns-route53`. " +
      "Requires the certbot-dns-route53 plugin installed on the box. Defaults to staging.",
    inputSchema: {
      domain: z.string().describe("Base domain, e.g. julcap.net - issues it plus *.julcap.net"),
      staging: z.boolean().default(true),
      email: z.string().optional(),
    },
  },
  async ({ domain, staging, email }) => {
    const result = await issueWildcardCert({ domain, staging, email });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "renew_cert",
  {
    description:
      "Run `certbot renew`, optionally scoped to one cert via --cert-name. Defaults to " +
      "--dry-run - pass dry_run:false only when you mean to actually renew.",
    inputSchema: {
      domain: z.string().optional().describe("Cert name to renew; omit to renew everything due"),
      dry_run: z.boolean().default(true),
    },
  },
  async ({ domain, dry_run }) => {
    const result = await renewCert({ domain, dry_run });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "revoke_cert",
  {
    description:
      "Revoke a certificate with Let's Encrypt (e.g. after a key compromise). Destructive - " +
      "requires confirm:true. Leaves the cert files on disk; follow with delete_cert to remove them.",
    inputSchema: {
      domain: z.string().describe("certbot cert name"),
      confirm: z.boolean().default(false),
    },
  },
  async ({ domain, confirm }) => {
    const result = await revokeCert({ domain, confirm });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "delete_cert",
  {
    description:
      "Delete a certificate's files from certbot's store. Destructive - requires confirm:true. " +
      "If the cert may be compromised, call revoke_cert first.",
    inputSchema: {
      domain: z.string().describe("certbot cert name"),
      confirm: z.boolean().default(false),
    },
  },
  async ({ domain, confirm }) => {
    const result = await deleteCert({ domain, confirm });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
