---
name: web-design-guidelines
description: Review significant new or changed UI, or explicit UI/UX/accessibility requests, against pinned Vercel Web Interface Guidelines. Use for quality review at completion; skip tiny frontend edits and unrelated backend work.
metadata:
  author: vercel
  version: "1.0.0"
---

# Web design quality review

Adapted from Vercel's pinned web-design-guidelines skill. This is a scoped review skill, not a requirement to load all design skills on every frontend request.

1. Identify the affected page/components from the request, changed files, and system-knowledge. Ask only if review scope cannot be inferred.
2. Read the relevant rule sections in [pinned guidelines](references/guidelines.md). This repository uses a fixed snapshot for repeatable team behavior; do not silently fetch mutable main on every review. Fetch newer official guidance when the user requests current guidance and clearly distinguish it from the pinned baseline.
3. Review hierarchy/layout/type/spacing, forms/navigation, responsiveness, usable controls, loading/empty/error/disabled states, visual consistency, keyboard/focus, labels/semantics, contrast, reduced motion, and theme/RTL as applicable.
4. Inspect code and use targeted browser evidence where needed. A code checklist alone does not prove browser behavior or full accessibility conformance.
5. Report actionable findings with repository-relative file and line, observed problem, impact, and a concrete correction. Separate unverified concerns from observed defects; omit empty categories and trivial style preferences.
6. If implementing a feature, fix issues in scope and re-verify. A review-only request does not authorize unrelated redesign.

Interpret upstream recommendations in the context of the application's framework, languages, existing components, and actual usability. Do not mechanically introduce libraries, changed copy, unsaved-change prompts, or URL state for every control solely to satisfy a guideline.

[Original upstream skill](UPSTREAM.md) preserves attribution. Its fresh-fetch and unconditional ask-for-files steps are superseded by this scoped workflow.
