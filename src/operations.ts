import { randomUUID } from "node:crypto";
import { isDomainAllowed, isToolEnabled, type Policy } from "./policy.js";

export type ExecutionStatus = "running" | "succeeded" | "failed" | "denied" | "interrupted";
export type VerificationStatus = "not_requested" | "pending" | "passed" | "failed" | "unavailable";
export type StepStatus = "pending" | "succeeded" | "failed" | "skipped" | "unavailable";

export interface OperationStep {
  name: string;
  status: StepStatus;
  summary?: string;
}

export interface OperationEvidence {
  kind: string;
  status: "passed" | "failed" | "pending" | "unavailable";
  summary: string;
}

export interface OperationError {
  code?: string;
  message: string;
}

export interface RollbackOutcome {
  status: "not_needed" | "succeeded" | "failed" | "unknown";
  summary?: string;
}

export interface OperationRecord {
  schemaVersion: 1;
  id: string;
  tool: string;
  mutating: boolean;
  target?: string;
  args: Record<string, unknown>;
  client?: { displayName?: string; identityTrusted: false };
  startedAt: string;
  finishedAt?: string;
  executionStatus: ExecutionStatus;
  verificationStatus: VerificationStatus;
  steps: OperationStep[];
  evidence: OperationEvidence[];
  errors: OperationError[];
  rollback?: RollbackOutcome;
}

export interface StartOperationInput {
  tool: string;
  mutating: boolean;
  target?: string;
  args: Record<string, unknown>;
  client?: { displayName?: string };
}

export interface FinishOperationInput {
  executionStatus: Exclude<ExecutionStatus, "running">;
  verificationStatus: VerificationStatus;
  steps?: OperationStep[];
  evidence?: OperationEvidence[];
  errors?: OperationError[];
  rollback?: RollbackOutcome;
}

export interface ListOperationsInput {
  pageSize?: number;
  cursor?: string;
  tool?: string;
  executionStatus?: ExecutionStatus;
  verificationStatus?: VerificationStatus;
}

export interface OperationPage {
  operations: OperationRecord[];
  nextCursor?: string;
}

export interface OperationHistory {
  start(input: StartOperationInput): OperationRecord;
  finish(id: string, update: FinishOperationInput): OperationRecord;
  get(id: string, visible?: (record: OperationRecord) => boolean): OperationRecord | null;
  list(input?: ListOperationsInput, visible?: (record: OperationRecord) => boolean): OperationPage;
}

export interface InMemoryOperationHistoryOptions {
  maxRecords?: number;
  now?: () => Date;
}

const SECRET_KEY_RE = /secret|password|passwd|token|api[_-]?key|access[_-]?key|credential/i;
const AUTHORIZATION_RE = /\bauthorization\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const EMBEDDED_SECRET_RE = /\b(secret|password|passwd|token|api[_ -]?key|access[_ -]?key|credential)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const URL_CREDENTIAL_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;
export const MAX_OPERATION_STRING_LENGTH = 500;
export const MAX_OPERATION_CURSOR_LENGTH = 512;
export const MAX_OPERATION_RECORD_BYTES = 64 * 1024;
export const MAX_IN_MEMORY_OPERATION_RECORDS = 1_000;
const MAX_ARRAY = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 6;
const MAX_DETAILS = 20;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SUPPORTED_OPERATION_TOOLS = {
  update_site: { mutating: true, targetArgument: "domain" },
} as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasAuthoritativeMetadata(
  tool: unknown,
  mutating: unknown,
  target: unknown,
  args: unknown
): args is Record<string, unknown> {
  if (typeof tool !== "string" || !Object.hasOwn(SUPPORTED_OPERATION_TOOLS, tool)) return false;
  const metadata = SUPPORTED_OPERATION_TOOLS[tool as keyof typeof SUPPORTED_OPERATION_TOOLS];
  if (mutating !== metadata.mutating || typeof target !== "string" || target.length > MAX_OPERATION_STRING_LENGTH) return false;
  return isPlainRecord(args) && typeof args[metadata.targetArgument] === "string" && args[metadata.targetArgument] === target;
}

function redactOperationString(value: string): string {
  return value
    .replace(AUTHORIZATION_RE, "Authorization: ***")
    .replace(URL_CREDENTIAL_RE, "$1[redacted]@")
    .replace(EMBEDDED_SECRET_RE, (_match, key: string, separator: string) => `${key}${separator}[redacted]`);
}

function boundedString(value: unknown): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const text = redactOperationString(raw);
  return text.length > MAX_OPERATION_STRING_LENGTH
    ? `${text.slice(0, MAX_OPERATION_STRING_LENGTH - 1)}…`
    : text;
}

export function sanitizeOperationValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number, key?: string): unknown => {
    if (key && SECRET_KEY_RE.test(key)) return "[redacted]";
    if (typeof current === "string") {
      const redacted = redactOperationString(current);
      return redacted.length > MAX_OPERATION_STRING_LENGTH
        ? `${redacted.slice(0, MAX_OPERATION_STRING_LENGTH)}… [+${redacted.length - MAX_OPERATION_STRING_LENGTH} chars]`
        : redacted;
    }
    if (typeof current === "number" || typeof current === "boolean" || current === null) return current;
    if (typeof current === "bigint") return current.toString();
    if (current === undefined) return null;
    if (typeof current !== "object") return `[${typeof current}]`;
    if (seen.has(current)) return "[circular]";
    if (depth >= MAX_DEPTH) return "[max depth]";
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        return current.slice(0, MAX_ARRAY).map((item) => visit(item, depth + 1));
      }
      const output: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(current).slice(0, MAX_OBJECT_KEYS)) {
        Object.defineProperty(output, boundedString(childKey), {
          value: visit(childValue, depth + 1, childKey),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return output;
    } finally {
      seen.delete(current);
    }
  };
  return visit(value, 0);
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sanitizeFinish(update: FinishOperationInput): FinishOperationInput {
  return {
    executionStatus: update.executionStatus,
    verificationStatus: update.verificationStatus,
    steps: (update.steps ?? []).slice(0, MAX_DETAILS).map((step) => ({
      name: boundedString(step.name),
      status: step.status,
      ...(step.summary === undefined ? {} : { summary: boundedString(step.summary) }),
    })),
    evidence: (update.evidence ?? []).slice(0, MAX_DETAILS).map((item) => ({
      kind: boundedString(item.kind),
      status: item.status,
      summary: boundedString(item.summary),
    })),
    errors: (update.errors ?? []).slice(0, MAX_DETAILS).map((error) => ({
      ...(error.code === undefined ? {} : { code: boundedString(error.code) }),
      message: boundedString(error.message),
    })),
    ...(update.rollback
      ? {
          rollback: {
            status: update.rollback.status,
            ...(update.rollback.summary === undefined ? {} : { summary: boundedString(update.rollback.summary) }),
          },
        }
      : {}),
  };
}

function cursorFor(record: OperationRecord): string {
  return Buffer.from(JSON.stringify({ startedAt: record.startedAt, id: record.id }), "utf-8").toString("base64url");
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function parseCursor(raw: string): { startedAt: string; id: string } {
  try {
    if (raw.length === 0 || raw.length > MAX_OPERATION_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const decoded = Buffer.from(raw, "base64url");
    if (decoded.toString("base64url") !== raw || decoded.byteLength > MAX_OPERATION_CURSOR_LENGTH) throw new Error();
    const parsed: unknown = JSON.parse(decoded.toString("utf-8"));
    if (!isPlainRecord(parsed) || !isCanonicalTimestamp(parsed.startedAt) || typeof parsed.id !== "string" || !ID_RE.test(parsed.id)) {
      throw new Error();
    }
    return { startedAt: parsed.startedAt, id: parsed.id };
  } catch {
    throw new Error("Invalid operation cursor.");
  }
}

function compareNewestFirst(a: OperationRecord, b: OperationRecord): number {
  return b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id);
}

function assertRecordSize(record: OperationRecord): void {
  if (Buffer.byteLength(JSON.stringify(record), "utf-8") > MAX_OPERATION_RECORD_BYTES) {
    throw new Error(`Operation record exceeds the maximum serialized size of ${MAX_OPERATION_RECORD_BYTES} bytes.`);
  }
}

export class InMemoryOperationHistory implements OperationHistory {
  private readonly records = new Map<string, OperationRecord>();
  private readonly maxRecords: number;
  private readonly now: () => Date;

  constructor(options: InMemoryOperationHistoryOptions = {}) {
    this.maxRecords = options.maxRecords ?? MAX_IN_MEMORY_OPERATION_RECORDS;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > 10_000) {
      throw new Error("Operation maxRecords must be an integer from 1 to 10000.");
    }
  }

  start(input: StartOperationInput): OperationRecord {
    if (!hasAuthoritativeMetadata(input.tool, input.mutating, input.target, input.args)) {
      throw new Error("Unsupported or inconsistent operation metadata.");
    }
    this.makeRoomForStart();
    const sanitizedArgs = sanitizeOperationValue(input.args);
    const record: OperationRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      tool: input.tool,
      mutating: input.mutating,
      target: boundedString(input.target),
      args: isPlainRecord(sanitizedArgs) ? sanitizedArgs : {},
      ...(input.client
        ? { client: { ...(input.client.displayName ? { displayName: boundedString(input.client.displayName) } : {}), identityTrusted: false } }
        : {}),
      startedAt: this.now().toISOString(),
      executionStatus: "running",
      verificationStatus: "not_requested",
      steps: [],
      evidence: [],
      errors: [],
    };
    assertRecordSize(record);
    this.records.set(record.id, record);
    return copy(record);
  }

  finish(id: string, update: FinishOperationInput): OperationRecord {
    const current = this.records.get(id);
    if (!current) throw new Error(`Operation "${id}" was not found.`);
    if (current.executionStatus !== "running") {
      throw new Error(`Operation "${id}" is already ${current.executionStatus}.`);
    }
    const safe = sanitizeFinish(update);
    const record: OperationRecord = {
      ...current,
      executionStatus: safe.executionStatus,
      verificationStatus: safe.verificationStatus,
      finishedAt: this.now().toISOString(),
      steps: safe.steps ?? [],
      evidence: safe.evidence ?? [],
      errors: safe.errors ?? [],
      ...(safe.rollback ? { rollback: safe.rollback } : {}),
    };
    assertRecordSize(record);
    this.records.set(id, record);
    return copy(record);
  }

  get(id: string, visible: (record: OperationRecord) => boolean = () => true): OperationRecord | null {
    if (!ID_RE.test(id)) return null;
    const record = this.records.get(id);
    return record && visible(record) ? copy(record) : null;
  }

  list(input: ListOperationsInput = {}, visible: (record: OperationRecord) => boolean = () => true): OperationPage {
    const pageSize = input.pageSize ?? 20;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new Error("Operation pageSize must be an integer from 1 to 100.");
    }
    const cursor = input.cursor ? parseCursor(input.cursor) : null;
    let records = [...this.records.values()]
      .filter(visible)
      .filter((record) => !input.tool || record.tool === input.tool)
      .filter((record) => !input.executionStatus || record.executionStatus === input.executionStatus)
      .filter((record) => !input.verificationStatus || record.verificationStatus === input.verificationStatus)
      .sort(compareNewestFirst);
    if (cursor) {
      records = records.filter(
        (record) => record.startedAt < cursor.startedAt || (record.startedAt === cursor.startedAt && record.id < cursor.id)
      );
    }
    const operations = records.slice(0, pageSize);
    return {
      operations: operations.map(copy),
      ...(records.length > pageSize ? { nextCursor: cursorFor(operations[operations.length - 1]) } : {}),
    };
  }

  private makeRoomForStart(): void {
    const records = [...this.records.values()];
    const running = records.filter((record) => record.executionStatus === "running");
    if (running.length >= this.maxRecords) {
      throw new Error("Operation history is at capacity with running operations.");
    }
    const terminalBudget = this.maxRecords - running.length - 1;
    const terminal = records.filter((record) => record.executionStatus !== "running").sort(compareNewestFirst);
    for (const record of terminal.slice(terminalBudget)) this.records.delete(record.id);
  }
}

export function operationVisible(policy: Policy, record: OperationRecord): boolean {
  if (!hasAuthoritativeMetadata(record.tool, record.mutating, record.target, record.args)) return false;
  const metadata = SUPPORTED_OPERATION_TOOLS[record.tool as keyof typeof SUPPORTED_OPERATION_TOOLS];
  if (!isToolEnabled(policy, record.tool, !metadata.mutating)) return false;
  if (!policy.allowedDomains) return true;
  return isDomainAllowed(policy, record.target as string);
}

export interface UpdateSiteObservableResult {
  success: boolean;
  test_output: string;
  reload_required: boolean;
  backup_created?: boolean;
}

export function classifyUpdateSiteResult(result: UpdateSiteObservableResult): FinishOperationInput {
  if (result.success) {
    return {
      executionStatus: "succeeded",
      verificationStatus: result.reload_required ? "pending" : "unavailable",
      steps: [
        { name: "backup_config", status: result.backup_created ? "succeeded" : "skipped" },
        { name: "write_config", status: "succeeded" },
        { name: "test_local_nginx_config", status: "succeeded" },
        {
          name: "reload_nginx",
          status: result.reload_required ? "pending" : "unavailable",
          summary: result.reload_required ? "Required but not performed by update_site." : "Reload state was not reported.",
        },
      ],
      evidence: [
        { kind: "local_nginx_config_test", status: "passed", summary: "Local nginx configuration test passed." },
        {
          kind: "live_service",
          status: result.reload_required ? "pending" : "unavailable",
          summary: result.reload_required
            ? "Nginx reload was not performed; live service and public reachability remain unverified."
            : "Live service verification was unavailable.",
        },
      ],
      rollback: { status: "not_needed" },
    };
  }
  if (result.backup_created) {
    return {
      executionStatus: "failed",
      verificationStatus: "failed",
      steps: [
        { name: "backup_config", status: "succeeded" },
        { name: "write_config", status: "succeeded" },
        { name: "test_local_nginx_config", status: "failed" },
        { name: "restore_previous_config", status: "succeeded" },
        { name: "reload_nginx", status: "skipped", summary: "Not attempted after the local configuration test failed." },
      ],
      evidence: [
        { kind: "local_nginx_config_test", status: "failed", summary: "Local nginx configuration test failed; the previous config was restored." },
        { kind: "live_service", status: "unavailable", summary: "Live service was not changed or verified." },
      ],
      errors: [{ code: "LOCAL_CONFIG_TEST_FAILED", message: "The local nginx configuration test failed." }],
      rollback: { status: "succeeded", summary: "The previous site config was restored." },
    };
  }
  return {
    executionStatus: "failed",
    verificationStatus: "unavailable",
    steps: [
      { name: "update_site", status: "failed", summary: "The workflow failed before local verification completed." },
      { name: "reload_nginx", status: "skipped", summary: "Not attempted." },
    ],
    evidence: [
      { kind: "local_nginx_config_test", status: "unavailable", summary: "No completed local nginx configuration test was recorded." },
      { kind: "live_service", status: "unavailable", summary: "Live service and public reachability were not tested." },
    ],
    errors: [{ code: "UPDATE_SITE_FAILED", message: "update_site reported failure before verification completed." }],
    rollback: { status: "not_needed" },
  };
}