---
name: gpt-taste
description: Design or substantially improve significant OO-Ushers pages, dashboards, modals, or visual components when hierarchy/layout decisions matter. Skip minor edits, routine component reuse, backend work, and business logic; preserve the existing design system and supplied references.
---

# Taste for this repository

This is the GPT/Codex Taste variant, adapted from a pinned Leonxlnx/taste-skill source. The project constraints below take precedence over upstream style mandates.

## Scope and evidence
Use only for significant visual design or an explicit design improvement request. Start with system-knowledge's INDEX and relevant frontend domain/source files; inspect existing components, typography, color tokens, spacing, icons, theme, language/RTL, and interaction patterns. Do not redesign unrelated pages.

## Design workflow
1. Identify the user's purpose, primary action, hierarchy, content density, and relevant responsive states.
2. Reuse the application's design system. Propose only the visual decisions needed for the affected surface.
3. Implement a coherent layout with readable type, consistent spacing, clear action priority, composed components, responsive behavior, and useful interactions.
4. Verify contrast, keyboard/focus behavior, overflow, loading/empty/error/disabled states, reduced motion, themes, and Arabic/RTL where affected. Use targeted browser verification and a guideline review for substantial UI.

Supplied screenshots/mockups are authoritative. Taste must not replace their layout, typography, or palette with a new direction. Missing reference details use existing project patterns.

## Upstream conflict resolutions
Do not force AIDA marketing sections onto dashboards/forms/modals. No random layout selection, simulated Python execution, mandatory GSAP, new font/icon library, arbitrary stock imagery, blanket Inter ban, or giant spacing. Choose motion only when it helps; existing CSS/components normally suffice. Never claim a simulation or unrun check was executed.

[Original GPT Taste source](UPSTREAM.md) preserves upstream provenance. Consult only relevant numbered sections when extra design ideas are useful; its conflicting mandates are not project instructions. Keep the preflight short and proportional.

Do not preload Image-to-Code or architecture planning. Select them only for their own triggers. Follow system-knowledge for behavior changes; purely visual fixes do not require unrelated domain updates.
