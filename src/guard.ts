import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuditLogger, redactArgs, truncate, type AuditOutcome } from "./audit.js";
import { isToolEnabled, unmatchedPatterns, type Policy } from "./policy.js";

// Every tool is registered through this instead of server.registerTool
// directly, so cross-cutting behaviour (auditing, and policy checks) lives in
// one place rather than being repeated in each of the tool handlers.

export interface GuardOptions {
  audit: AuditLogger;
  policy: Policy;
  getClient?: () => string | undefined;
}

// Pulls a short human-readable line out of whatever shape a tool returned.
function summarize(result: any): { outcome: AuditOutcome; message?: string } {
  if (result?.isError) {
    const text = result.content?.find((c: any) => c.type === "text")?.text;
    return { outcome: "error", message: text ? truncate(String(text)) : undefined };
  }
  const data = result?.structuredContent;
  const message = data?.message ?? data?.test_output ?? data?.certbot_output;
  return {
    outcome: data?.success === false ? "failed" : "ok",
    message: typeof message === "string" ? truncate(message) : undefined,
  };
}

// `confirm:false` on a destructive tool, or `dry_run:true` on renew_cert, means
// the call changed nothing - worth flagging so the trail reads correctly.
function dryRunField(args: any): { dry_run?: boolean } {
  if (typeof args?.confirm === "boolean") return { dry_run: !args.confirm };
  if (typeof args?.dry_run === "boolean") return { dry_run: args.dry_run };
  return {};
}

export interface Registrar {
  registerTool: McpServer["registerTool"];
  // Call after every tool has been registered.
  summary(): { registered: string[]; skipped: string[]; warnings: string[] };
}

export function createRegistrar(server: McpServer, options: GuardOptions): Registrar {
  const { audit, policy, getClient } = options;
  const register = server.registerTool.bind(server) as (...args: any[]) => unknown;
  const registered: string[] = [];
  const skipped: string[] = [];

  const registerTool = ((name: string, config: any, handler: (...args: any[]) => Promise<any>) => {
    const mutating = config.annotations?.readOnlyHint !== true;

    // Tools the operator has switched off are never registered, so the agent
    // can't see or call them - there's nothing to argue its way past.
    if (!isToolEnabled(policy, name, !mutating)) {
      skipped.push(name);
      return undefined;
    }
    registered.push(name);
    const hasInput = config.inputSchema !== undefined;

    const wrapped = async (...cbArgs: any[]) => {
      const args = hasInput ? cbArgs[0] : {};
      const started = Date.now();

      const record = (outcome: AuditOutcome, message?: string) => {
        if (!mutating && !audit.logReads && outcome !== "denied") return Promise.resolve();
        return audit.record({
          ts: new Date(started).toISOString(),
          tool: name,
          mutating,
          client: getClient?.(),
          args: redactArgs(args),
          ...dryRunField(args),
          outcome,
          message,
          duration_ms: Date.now() - started,
        });
      };

      let result: any;
      try {
        result = await handler(...cbArgs);
      } catch (err: any) {
        await record("error", truncate(err?.message ?? String(err)));
        throw err;
      }
      const { outcome, message } = summarize(result);
      await record(outcome, message);
      return result;
    };

    return register(name, config, wrapped);
  }) as McpServer["registerTool"];

  return {
    registerTool,
    summary: () => ({
      registered,
      skipped,
      warnings: unmatchedPatterns(policy, [...registered, ...skipped]).map(
        (p) => `MCP_ENABLED_TOOLS entry "${p}" matches no tool`
      ),
    }),
  };
}
