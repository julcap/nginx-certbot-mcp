// Operator-configured limits on what the agent may do. Read once at startup
// from the environment - deliberately not something a tool argument can change.

export type Mode = "readwrite" | "readonly";

export interface Policy {
  mode: Mode;
  // null = no allowlist, every tool the mode permits is registered.
  enabledTools: string[] | null;
}

const TOOL_PATTERN_RE = /^[a-z0-9_*]+$/;

function splitList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadPolicy(env: NodeJS.ProcessEnv = process.env): Policy {
  const rawMode = (env.MCP_MODE ?? "readwrite").trim().toLowerCase();
  if (rawMode !== "readwrite" && rawMode !== "readonly") {
    throw new Error(`Invalid MCP_MODE "${env.MCP_MODE}": expected "readwrite" (default) or "readonly".`);
  }

  const enabled = splitList(env.MCP_ENABLED_TOOLS).map((p) => p.toLowerCase());
  for (const pattern of enabled) {
    if (!TOOL_PATTERN_RE.test(pattern)) {
      throw new Error(`Invalid MCP_ENABLED_TOOLS entry "${pattern}": use tool names, with * as a wildcard (e.g. check_*).`);
    }
  }

  return { mode: rawMode, enabledTools: enabled.length > 0 ? enabled : null };
}

// "check_*" -> /^check_.*$/ ; everything else matches literally.
function patternToRegExp(pattern: string): RegExp {
  return new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}

function matchesAny(patterns: string[], name: string): boolean {
  return patterns.some((p) => patternToRegExp(p).test(name));
}

export function isToolEnabled(policy: Policy, name: string, readOnly: boolean): boolean {
  if (policy.mode === "readonly" && !readOnly) return false;
  if (policy.enabledTools && !matchesAny(policy.enabledTools, name)) return false;
  return true;
}

// Allowlist entries that matched none of the tools the server defines -
// almost always a typo, and silently exposing nothing is a bad failure mode.
export function unmatchedPatterns(policy: Policy, allToolNames: string[]): string[] {
  if (!policy.enabledTools) return [];
  return policy.enabledTools.filter((p) => !allToolNames.some((n) => patternToRegExp(p).test(n)));
}
