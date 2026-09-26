---
name: solution-architect
description: Plan large, complex, or architecturally significant OO-Ushers changes when workflow, data, permissions, integrations, concurrency, or regression risk justify design first. Skip simple CRUD, isolated fixes, UI edits, and explanations; touching frontend and backend alone is insufficient.
---

# Solution architect

Design the smallest sound solution that fits the existing system. Architecture should reduce complexity, not create it. Use this repository's copy when multiple workspaces expose this skill.

## Decide whether architecture adds value

Before activating the workflow, internally evaluate domains and layers affected, frontend/backend interaction, data/schema impact, permissions, business rules, state transitions, integrations, performance, security, concurrency, dependencies, regression risk, migrations, compatibility, and the amount of new architecture.

Use engineering judgment rather than a point score. Activate when several factors are significant, or a single architectural risk is substantial enough to justify planning: a new subsystem, complex workflow, major role/API/schema change, asynchronous processing, performance-sensitive path, significant refactor, integration, or high regression/security risk. Work with meaningful dependent implementation phases is another signal.

Do not activate merely because both frontend and backend change. Ordinary CRUD, one simple field, endpoint property updates, text/spacing edits, variable renaming, an isolated bug, or a local permission display change usually need direct implementation. Explanations and bug investigations do not need architecture unless evidence reveals a larger design problem. An explicit mention of this skill on a simple task does not justify unnecessary architecture; apply the same proportionality.

Calibration:
- Complete notification subsystem, background payment-expiration jobs, multi-stage approval workflow, or a new role spanning modules: use.
- Partner pricing with intertwined business rules and data/contracts: likely use, after checking complexity.
- Button text, validation message, UI spacing, simple CRUD across frontend/backend, or one isolated bug: skip.
- Hiding a field for admins: normally skip; escalate only if actual backend access policy spans multiple workflows.

For simple work: understand → implement → verify, using system-knowledge where relevant. If investigation reveals architectural complexity, switch to this workflow with a brief explanation.

## Establish evidence before design

1. Follow [system-knowledge](../system-knowledge/SKILL.md). Start at its [INDEX](../system-knowledge/knowledge/INDEX.md); load only affected domains and [ROLES](../system-knowledge/knowledge/ROLES.md) when access changes.
2. Inspect the actual source entry points identified there. Source code is authoritative. Do not preload the knowledge base or scan the entire repository when routing already identifies relevant areas.
3. Read applicable AGENTS.md and repository/Cursor/Codex rules, lint configuration, and relevant project conventions. Reuse existing architecture, components, hooks, services, utilities, validators, types, permission helpers, API clients, error handling, notification mechanisms, and shared business logic.
4. Identify current business invariants, roles/ownership, data models, APIs, lifecycle, dependencies, and integration boundaries. Distinguish observed behavior from proposed behavior.
5. Inspect the other repository's relevant knowledge/source when it is available and within scope. A sibling checkout is not required to use this skill. When it is unavailable, identify the unverified contract and required coordination rather than inventing its implementation.

Paths in plans and shared artifacts must be relative to their repository root. Identify the owning repository for cross-repository paths, without assuming a local directory layout.

## Requirements and impact

Translate the request into functional requirements, business rules, actors/permissions, validation, state transitions, data/API requirements, frontend/backend behavior, side effects, failure scenarios, edge cases, and compatibility needs. Do not invent business rules. Separate confirmed requirements, reasonable assumptions, and open questions.

Ask for missing decisions only when they materially affect correctness or design. Continue independent investigation while waiting; an unanswered question is not approval for a business rule.

Map impact to affected domains, APIs, database, authorization, workflows, shared services, integrations, notifications, background processing/caching if present or proposed, and tests. Identify dependencies and regressions before implementation. State measurable acceptance criteria and the relevant invariants.

## Design within current architecture

Prefer extending existing patterns over parallel implementations or new frameworks, libraries, infrastructure, or abstraction layers. Introduce a new mechanism only with a concrete need and an explanation of its operational cost.

Apply SOLID when it improves the result: focused responsibilities, extension points that avoid unrelated edits, predictable substitutable contracts, narrow interfaces, and business logic decoupled from unnecessary infrastructure details. Do not introduce abstractions simply to claim compliance.

Use descriptive names appropriate to context and focused, predictable, testable functions. Avoid giant functions, deep nesting, duplicate rules, magic values, and hidden side effects.

Show only relevant changed/new folders and files, using the repository's existing conventions. Separate an existing reusable element from a proposed addition.

### Data and migrations — when applicable

Specify fields, relationships, constraints, uniqueness, nullability, indexes and query patterns. Protect business invariants at the appropriate application/database boundary. Consider current records, defaults/backfill, data volume, and duplication.

Plan migration order, old/new client and schema coexistence, rollout, rollback or roll-forward, and any irreversible data transformation. Do not assume deployments across repositories are simultaneous.

### APIs and frontend/backend contracts — when applicable

Define endpoint responsibility, request/response shapes, validation, authorization/ownership, expected errors, and compatibility. Include idempotency when retries can repeat effects. Follow existing naming, serialization, pagination, and error conventions.

Describe frontend states and actions, loading/empty/error behavior, API adapter/types, reusable UI/hooks, and role-specific presentation. Backend enforces critical permissions and invariants; frontend controls only represent them.

### Security and failures — when applicable

Evaluate authentication, authorization, record ownership, mass assignment, input validation, sensitive-field exposure, injection, file handling, rate limits, and audit requirements in the affected paths.

Plan resource-not-found, invalid-state, denied-access, duplicate requests, network/external failures, partial completion, and concurrent updates. Use existing error patterns. For side effects, define what persists, what retries, and how recovery avoids duplicate effects.

### Concurrency and asynchronous work — when applicable

Identify resources that multiple users/processes can modify and the invariants at risk. Choose transactions, atomic updates, optimistic/pessimistic locking, uniqueness, or idempotency only where needed; define boundaries rather than merely naming mechanisms.

If introducing background work, specify trigger/ownership, job payload/contract, retries/backoff, duplicate delivery, ordering if required, timeout, failed-job recovery, and observability. Explain consistency and what users see while work is pending.

### Performance — when applicable

Identify concrete workload assumptions and likely bottlenecks: N+1 queries, repeated reads/requests, oversized payloads, expensive computation, unnecessary renders, large lists, sequential independent calls, search/filtering, or external latency.

Choose pagination, indexing, batching, lazy loading, concurrency, async processing, memoization, or caching only with a reason. For caches, define scope, freshness/invalidation, and permission isolation. Include a way to measure success; avoid speculative optimization.

### Important trade-offs

For consequential choices, record decision, why it fits this system, a reasonable alternative, and why that alternative was not selected. Omit trivial implementation choices.

## Plan phases and team work

Choose phases according to the feature rather than copying a universal data/backend/API/frontend/testing sequence. Each phase includes:
- Goal and acceptance outcome.
- Dependencies and entry conditions.
- Affected components/files and implementation approach.
- Risks, compatibility or migration requirements.
- Verification and completion conditions.

Explicitly distinguish sequential dependencies from safe parallel workstreams. Establish shared contracts first when frontend/backend work can then proceed independently. Specify integration checkpoints, ownership boundaries, and shared-file overlap to reduce conflicts. Do not claim dependent schema/data access/business logic can proceed independently without a stable contract.

Identifying parallel workstreams does not itself authorize spawning agents, creating tasks, or delegating work. Follow the user's request and applicable execution permissions.

## Verification and knowledge maintenance

Choose risk-based checks for important logic and workflows: unit, integration/API, role/ownership, UI, end-to-end, and regression cases as applicable. Include state transitions, duplicates/retries, concurrent updates, migration compatibility, and partial failure when relevant. Use existing test tooling; distinguish local test evidence from external integration verification.

After implementation, follow system-knowledge to update only domain sections affected by actual behavior, contracts, models, permissions, or integrations. Update ROLES only for permission changes and INDEX only for navigation changes. A proposed architecture is not current behavior: keep plans separate from maintained knowledge until implemented. Preserve unrelated sections and resolve knowledge conflicts against the final merged code.

## Match the requested outcome

For explicit "plan" or "design" requests, produce the plan and do not modify application code. Make assumptions/open decisions clear; do not silently implement.

For "implement", "build", "add", or "change" requests that justify architecture: understand → architect → plan → implement → verify → update system knowledge. Create a sufficient internal plan and continue the authorized work; do not stop at delivering a plan or add an unnecessary plan-approval checkpoint. User-specified approval or scope constraints still apply.

Keep planning proportional: a medium-complexity change needs a short plan; a large subsystem may need a detailed phased design. Do not create durable architecture documents or extra artifacts unless requested or meaningfully useful.

## Explicit architecture deliverable

Include only applicable sections:
- Feature summary and acceptance criteria.
- Existing-system impact and evidence/source paths.
- Proposed architecture and reuse.
- Implementation phases and dependencies.
- Safe parallel workstreams and integration checkpoints.
- Backend and frontend changes.
- Data model/migration and API contracts.
- Permissions/security and performance.
- Testing strategy.
- Risks, edge cases, assumptions/open questions.
- Important trade-offs.
- Relevant folder/file structure.

Use pseudocode or diagrams only when they clarify a real design question; do not output boilerplate sections.

## Team sharing

All instructions are in this tracked repository skill; its system-knowledge dependency is also tracked here. No personal memory, global skill, absolute machine paths, secrets, credentials, or developer-specific setup may be required.

Codex discovers root repository skills under `.agents/skills/` with implicit invocation enabled by default. The scoped description and root AGENTS.md complexity gate constrain selection; no personal configuration is needed. Skill discovery is not a deterministic enforcement engine: follow the complexity gate before planning.

Repository convention verified against [official Codex skill documentation](https://learn.chatgpt.com/docs/build-skills) on 2026-09-26.
