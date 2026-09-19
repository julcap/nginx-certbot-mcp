// Operator-configured limits on what the agent may do. Read once at startup
// from the environment - deliberately not something a tool argument can change.

export type Mode = "readwrite" | "readonly";

export interface Policy {
  mode: Mode;
  // null = no allowlist, every tool the mode permits is registered.
  enabledTools: string[] | null;
  // null = any domain. Entries are exact names ("example.com") or
  // "*.example.com", which covers every subdomain but not the apex itself.
  allowedDomains: string[] | null;
}

const TOOL_PATTERN_RE = /^[a-z0-9_*]+$/;
// Optional "*." prefix, then a dotted name. A bare "*.com" is rejected below:
// it would allow an entire TLD and is almost certainly a mistake.
const DOMAIN_PATTERN_RE = /^(\*\.)?[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/;

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

  const domains = splitList(env.ALLOWED_DOMAINS).map((d) => d.toLowerCase().replace(/\.$/, ""));
  for (const pattern of domains) {
    const base = pattern.replace(/^\*\./, "");
    if (!DOMAIN_PATTERN_RE.test(pattern) || !base.includes(".")) {
      throw new Error(
        `Invalid ALLOWED_DOMAINS entry "${pattern}": use "example.com" or "*.example.com" (a bare TLD or "*" is not allowed).`
      );
    }
  }

  return {
    mode: rawMode,
    enabledTools: enabled.length > 0 ? enabled : null,
    allowedDomains: domains.length > 0 ? domains : null,
  };
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

// --- Domain allowlist ---

export function isDomainAllowed(policy: Policy, candidate: string): boolean {
  if (!policy.allowedDomains) return true;
  const name = candidate.toLowerCase().replace(/\.$/, "");
  return policy.allowedDomains.some((pattern) =>
    pattern.startsWith("*.") ? name.endsWith(pattern.slice(1)) : name === pattern
  );
}

// Predicate form, for filtering listings.
export function domainFilter(policy: Policy): (domain: string) => boolean {
  return (domain) => isDomainAllowed(policy, domain);
}

// issue_wildcard_cert covers "<domain>" and "*.<domain>", so both must be allowed.
const WILDCARD_TOOLS = new Set(["issue_wildcard_cert"]);
// `domain` is optional on these and omitting it means "everything" - which
// would reach past the allowlist, so a restricted server insists on one.
const DOMAIN_REQUIRED_WHEN_RESTRICTED = new Set(["renew_cert", "tail_site_logs"]);

// Returns why a call must be refused, or null if it may proceed.
export function checkDomainArgs(policy: Policy, tool: string, args: unknown): string | null {
  if (!policy.allowedDomains) return null;
  const domain = (args as { domain?: unknown } | undefined)?.domain;
  const allowed = policy.allowedDomains.join(", ");

  if (typeof domain !== "string") {
    return DOMAIN_REQUIRED_WHEN_RESTRICTED.has(tool)
      ? `${tool} needs an explicit domain on this server (allowed: ${allowed}).`
      : null;
  }
  if (!isDomainAllowed(policy, domain)) {
    return `Domain "${domain}" is not permitted by this server's ALLOWED_DOMAINS (allowed: ${allowed}).`;
  }
  if (WILDCARD_TOOLS.has(tool) && !isDomainAllowed(policy, `*.${domain}`)) {
    return `${tool} also covers "*.${domain}", which ALLOWED_DOMAINS does not permit (allowed: ${allowed}). Add "*.${domain}" to allow it.`;
  }
  return null;
}
