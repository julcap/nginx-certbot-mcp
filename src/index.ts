import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { listSites } from "./tools/listSites.js";
import { getSiteConfig } from "./tools/getSiteConfig.js";
import { checkCertExpiry } from "./tools/checkCertExpiry.js";
import { createServerBlock } from "./tools/createServerBlock.js";
import { reloadNginx } from "./tools/reloadNginx.js";
import { issueCert } from "./tools/issueCert.js";

const server = new McpServer({
  name: "nginx-certbot-mcp",
  version: "0.1.0",
});

// --- Read-only tools (fully implemented) ---

server.tool(
  "list_sites",
  "List all configured nginx server blocks with domain, upstream, and SSL status.",
  {},
  async () => {
    const sites = await listSites();
    return { content: [{ type: "text", text: JSON.stringify(sites, null, 2) }] };
  }
);

server.tool(
  "get_site_config",
  "Get the raw nginx config for a specific domain.",
  { domain: z.string().describe("The domain to look up, e.g. my.domain.com") },
  async ({ domain }) => {
    const result = await getSiteConfig(domain);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "check_cert_expiry",
  "List certbot-managed certificates and days until expiry.",
  {},
  async () => {
    const certs = await checkCertExpiry();
    return { content: [{ type: "text", text: JSON.stringify(certs, null, 2) }] };
  }
);

// --- Mutating tools (guardrails wired, shell calls stubbed - see TODOs) ---

server.tool(
  "create_server_block",
  "Create a new nginx server block from the websocket-capable default template. " +
    "Validates and test-renders before touching live config.",
  {
    domain: z.string(),
    upstream_host: z.string(),
    upstream_port: z.number().int().min(1).max(65535),
  },
  async ({ domain, upstream_host, upstream_port }) => {
    const result = await createServerBlock({ domain, upstream_host, upstream_port });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "reload_nginx",
  "Run `nginx -t` and reload only if the config test passes.",
  {},
  async () => {
    const result = await reloadNginx();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "issue_cert",
  "Request a certificate via `certbot --nginx`. Defaults to Let's Encrypt staging - " +
    "pass staging:false only when you mean it.",
  {
    domain: z.string(),
    staging: z.boolean().default(true),
    email: z.string().optional(),
  },
  async ({ domain, staging, email }) => {
    const result = await issueCert({ domain, staging, email });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
