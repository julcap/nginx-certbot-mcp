import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nginx-mcp-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// Starts the real server over stdio, exactly as an MCP client would, with the
// given environment layered over a clean one (no inherited AUDIT_/MCP_ vars).
export async function startServer(env: Record<string, string>): Promise<Client> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(AUDIT_|MCP_|ALLOWED_|RATE_|STATE_)/.test(k)) clean[k] = v;
  }
  const transport = new StdioClientTransport({
    command: path.resolve("node_modules/.bin/tsx"),
    args: ["src/index.ts"],
    env: { ...clean, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "unit-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

export function toolNames(list: { tools: { name: string }[] }): string[] {
  return list.tools.map((t) => t.name).sort();
}

export function textOf(result: any): string {
  return result.content?.find((c: any) => c.type === "text")?.text ?? "";
}
