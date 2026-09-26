# Shared application knowledge

For application behavior, permissions, API, model, or integration work, read and follow `.agents/skills/system-knowledge/SKILL.md`. Start with its small `knowledge/INDEX.md`, then load only relevant domain files and source code.

Update affected knowledge with behavior changes as one logical change. Update `knowledge/ROLES.md` when permissions change. Preserve unrelated documentation; source code is authoritative. Keep shared knowledge in this repository and use repository-relative paths without secrets or developer-specific information.

`IMPLEMENTATION.md` is a historical overview; the modular knowledge files are the maintained behavior reference. A documentation-only or behavior-preserving change does not require updating every domain.

## Architectural planning

Before application work, assess whether architectural planning adds meaningful value. For large, complex, or architecturally significant changes, follow `.agents/skills/solution-architect/SKILL.md` together with system-knowledge. Simple CRUD, isolated fixes, UI/text edits, and explanations proceed directly; touching frontend and backend alone does not justify architecture. Plan/design requests do not authorize implementation; implementation requests continue through verification and affected knowledge updates.

## Frontend design and browser verification

Select the smallest useful set: `gpt-taste` for substantial visual design; `web-design-guidelines` for significant UI quality review; `image-to-code` only for supplied visual references or a valuable image-first workflow; `playwright-cli` for targeted browser verification of meaningful flows. Skip these for tiny text/style edits, routine component reuse, and backend-only changes. A supplied screenshot outranks Taste style suggestions. Preserve the design system, existing shared skills, and unrelated code. Repository skill entrypoints override conflicting upstream mandates; source snapshots are optional references, not independent skills. See `.agents/tools/playwright/SETUP.md` for pinned sources, conflicts, and local setup. Do not load all installed skills or regenerate all knowledge.
