---
name: system-knowledge
description: Use OO-Ushers domain knowledge to investigate or change application behavior, permissions, API contracts, data models, and integrations; maintain only affected knowledge alongside code.
---

# Shared system knowledge

This skill and all required knowledge live in this Git repository. Use this repository's copy when multiple workspaces expose the same skill name.

## Read selectively

1. Read [knowledge/INDEX.md](knowledge/INDEX.md).
2. Read only the domain files relevant to the request. Read [knowledge/ROLES.md](knowledge/ROLES.md) for permission or role changes.
3. Inspect the source entry points listed in those files before relying on a rule. Source code is authoritative; correct relevant stale knowledge when encountered.
4. Expand exploration only when those sources leave a concrete question unanswered. Do not preload all knowledge or scan the entire repository for routine tasks.

All source paths in knowledge files are relative to the repository root; knowledge links are relative to the containing Markdown file.

## Keep code and knowledge one logical change

When a change affects behavior, API contracts, fields, validation, lifecycle, permissions, or integration constraints, update the affected domain sections in the same change. Update ROLES.md only for role/permission changes and INDEX.md only for navigation/domain changes. Read-only investigations and internal refactors with no documented behavior change do not require documentation edits.

Document the final implementation, including observable limitations. Never turn intended behavior into a claim that it already works. For contract changes, record implications for the other application repository in the local domain file; if that repository is available and in scope, update its corresponding code and knowledge too. Do not depend on its checkout to use this skill.

Make targeted edits, preserve unrelated sections and stable headings, and avoid regenerating the knowledge base. Resolve documentation conflicts against the final merged code, not whichever branch's prose wins.

Keep all important knowledge in repository files. Use repository-relative paths. Do not store personal information, personal memory, local machine paths, credentials, tokens, real customer data, or environment values. Describe configuration requirements by variable name only.

Before finishing, review the diff for affected knowledge, verify new links/paths and that files are not ignored, and report relevant checks and remaining contract gaps. Include code and knowledge together in any commit requested by the user; this skill does not itself authorize committing or pushing.

## Discovery

Codex discovers repository skills in `.agents/skills/`; automatic invocation is enabled by default. Root `AGENTS.md` requires this workflow for application work. No user-level installation, plugin, symlink, or account-specific configuration is required. Commit the root instructions and this complete skill directory together.

Convention verified against [official Codex skill documentation](https://learn.chatgpt.com/docs/build-skills) on 2026-09-26.
