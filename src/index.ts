import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { listSites } from "./tools/listSites.js";
import { getSiteConfig } from "./tools/getSiteConfig.js";
import { checkCertExpiry } from "./tools/checkCertExpiry.js";
import { createDomainRecord } from "./tools/createDomainRecord.js";
import { createServerBlock } from "./tools/createServerBlock.js";
import { reloadNginx } from "./tools/reloadNginx.js";
import { issueCert } from "./tools/issueCert.js";
import { removeSite } from "./tools/removeSite.js";
import { renewCert } from "./tools/renewCert.js";

const server = new McpServer({
  name: "nginx-certbot-mcp",
  version: "0.1.0",
});

// --- Read-only tools (fully implemented) ---

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

// --- Mutating tools (guardrails wired, shell calls stubbed - see TODOs) ---

server.registerTool(
  "create_domain_record",
  {
    description:
      "Upsert a Route 53 CNAME record pointing `domain` at `target`. " +
      "Run this before create_server_block / issue_cert and wait for DNS propagation.",
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
  "create_server_block",
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
    const result = await createServerBlock({ domain, upstream_host, upstream_port });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

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
  "remove_site",
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
    const result = await removeSite({ domain, confirm });
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

const transport = new StdioServerTransport();
await server.connect(transport);
