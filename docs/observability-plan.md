# Operation observability roadmap

This document defines the incremental path from the existing MCP server to an optional observability and verification console. The MCP server remains usable on its own. A future console is a distinct runtime over shared operation-model and policy code; it is not required to start or use MCP.

## Safety and terminology

An operation has two independent outcomes:

- `executionStatus`: `running`, `succeeded`, `failed`, `denied`, or `interrupted`.
- `verificationStatus`: `not_requested`, `pending`, `passed`, `failed`, or `unavailable`.

Execution success only means the requested workflow completed. It does not mean the change is live or publicly reachable. For example, `update_site` can write a config and pass a local `nginx -t`, but it deliberately does not reload nginx. Its successful operation record therefore has `executionStatus=succeeded` and `verificationStatus=pending`. The evidence states that reload and public reachability were not tested.

A process that exits before completion must never be recorded as succeeded. The first increment retains records only in the current process, so abrupt process exit loses the volatile record rather than converting it to success. Durable recovery and conservative `interrupted` classification remain deferred; a future implementation must not relabel work owned by another still-live process.

Client metadata is diagnostic context, not trusted human identity. The existing registrar remains the authoritative policy and audit gate. Operation-record reads pass through the same tool allowlist and domain visibility policy, and an inaccessible record is reported the same way as a missing record.

## Phase 1: operation-observability foundation

Implemented in this increment:

- A backend-neutral, versioned `OperationRecord` model with opaque UUIDs, sanitized target/arguments, untrusted client metadata, timestamps, separate execution and verification status, bounded steps/evidence/errors, and rollback outcome.
- `update_site` instrumentation in the central registrar. Existing workflow results and semantics are unchanged: no automatic reload, no additional infrastructure write, and no readiness claim.
- Correlation from the existing append-only audit entry to the operation ID.
- Read-only `list_operations` and `get_operation` MCP tools over a bounded current-process buffer, with bounded page size, opaque cursors, exact filters, and policy-filtered retrieval.
- Recursive secret-key redaction before records enter the buffer, 500-character string limits, 50-item argument collection limits, 20-item step/evidence/error limits, a 64 KiB record limit, and a fixed 1,000-record process-local cap.

The current-process buffer is deliberately **not durable operation-history persistence**. It is empty after every server start, is not shared across server processes, and is not an infrastructure-mutation lock. Running records are not evicted; when running records consume the cap, new observation records fail open without suppressing the policy gate, audit trail, or workflow result.

Observability remains non-authoritative. Buffer capacity or record-construction failure does not stop policy-gated, audited tool execution. The existing audit log remains the durable trail currently available; policy and audit startup failures remain fatal.

### Durable storage decision: paused

SQLite was evaluated first. The supported runtime is Node 20, so Node's newer built-in SQLite API cannot be used without an unsupported runtime upgrade. A maintained external SQLite driver introduces a native install/build dependency that has not yet been approved. Per the architecture boundary for this increment, the durable backend choice is therefore paused rather than replaced with a custom JSON-file or locking protocol. The `OperationHistory` interface isolates the eventual backend without claiming persistence today.

Before durable history is implemented, approve a maintained Node-20-compatible SQLite dependency and define schema migration, retention, startup recovery, multi-process access, file permissions, and failure behavior. SQLite storage locks would still not serialize or coordinate nginx, DNS, certbot, or other infrastructure mutations; host-wide mutation coordination requires a separate explicit design.

## Phase 2: broader workflow coverage and recovery

- Instrument additional mutating workflows through the registrar without bypassing policy or audit.
- Add explicit verification adapters with scopes such as local config, service state, DNS, certificate state, and public HTTP reachability.
- Add an approved durable store with migration/version handling and bounded retention.
- Add process ownership/lease data and conservative interrupted-operation recovery that only marks an owner proven dead.
- Preserve rollback evidence when a workflow exposes an authoritative outcome; use `unknown` otherwise.

## Phase 3: optional console API

- Add a separate, optional local console runtime in this repository over the shared history/policy layer.
- Default to loopback binding and read-only operation/history endpoints.
- Require explicit authentication and origin protections before any non-loopback exposure.
- Keep secrets, generic file browsing, arbitrary command execution, and configuration editing out of scope.
- Reapply domain visibility, tool allowlists, pagination, and presentation-time redaction at the API boundary.

The MCP stdio server must continue to start and work without the console runtime.

## Phase 4: verification panel frontend

- Render operation timelines, separate execution/verification badges, bounded evidence, errors, and known rollback outcome.
- Make pending, skipped, failed, and unavailable verification visually distinct.
- Never render `succeeded` as “live” when reload or public reachability is pending or unavailable.
- Use cursor pagination; do not load or expose the full retained history at once.

## Explicitly deferred

This roadmap does not add secret/config editors, a chatbot, billing, multi-tenancy, cloud provisioning, framework upgrades, production deployment, or generic infrastructure orchestration. Host-wide mutation coordination is a separate milestone and must use an explicit coordination design; future database storage locks are not that design.
