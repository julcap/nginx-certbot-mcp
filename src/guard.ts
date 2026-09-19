import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuditLogger, redactArgs, truncate, type AuditOutcome } from "./audit.js";
import { classifyUpdateSiteResult, type FinishOperationInput, type OperationHistory } from "./operations.js";
import { checkDomainArgs, isToolEnabled, unmatchedPatterns, type Policy } from "./policy.js";

// Every tool is registered through this instead of server.registerTool
// directly, so cross-cutting behaviour (auditing, and policy checks) lives in
// one place rather than being repeated in each of the tool handlers.

export interface GuardOptions {
  audit: AuditLogger;
  history?: OperationHistory;
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
  const { audit, history, policy, getClient } = options;
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
      const client = getClient?.();
      let operation: ReturnType<OperationHistory["start"]> | undefined;
      if (history && name === "update_site") {
        try {
          operation = history.start({
            tool: name,
            mutating,
            ...(typeof args?.domain === "string" ? { target: args.domain } : {}),
            args: redactArgs(args),
            ...(client ? { client: { displayName: client } } : {}),
          });
        } catch (err: any) {
          console.error(`[operations] failed to start ${name}: ${err?.message ?? err}`);
        }
      }

      const finishOperation = (update: FinishOperationInput) => {
        if (!operation || !history) return;
        try {
          history.finish(operation.id, update);
        } catch (err: any) {
          console.error(`[operations] failed to finish ${operation.id}: ${err?.message ?? err}`);
        }
      };

      const record = (outcome: AuditOutcome, message?: string) => {
        if (!mutating && !audit.logReads && outcome !== "denied") return Promise.resolve();
        return audit.record({
          ts: new Date(started).toISOString(),
          tool: name,
          mutating,
          client,
          args: redactArgs(args),
          ...dryRunField(args),
          outcome,
          message,
          ...(operation ? { operation_id: operation.id } : {}),
          duration_ms: Date.now() - started,
        });
      };

      const violation = checkDomainArgs(policy, name, args);
      if (violation) {
        finishOperation({
          executionStatus: "denied",
          verificationStatus: "not_requested",
          steps: [{ name: "policy_check", status: "failed", summary: "Denied before workflow execution." }],
          errors: [{ code: "POLICY_DENIED", message: violation }],
          rollback: { status: "not_needed" },
        });
        await record("denied", violation);
        return { isError: true, content: [{ type: "text", text: `Denied by policy: ${violation}` }] };
      }

      let result: any;
      try {
        result = await handler(...cbArgs);
      } catch (err: any) {
        const message = truncate(err?.message ?? String(err));
        finishOperation({
          executionStatus: "failed",
          verificationStatus: "unavailable",
          steps: [{ name: "update_site", status: "failed" }],
          evidence: [{ kind: "live_service", status: "unavailable", summary: "Workflow threw before verification completed." }],
          errors: [{ code: "WORKFLOW_ERROR", message }],
          rollback: { status: "unknown", summary: "The workflow threw before rollback outcome could be classified." },
        });
        await record("error", message);
        throw err;
      }
      if (operation) finishOperation(classifyUpdateSiteResult(result?.structuredContent ?? {}));
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
