---
name: image-to-code
description: Implement a supplied screenshot/image/mockup faithfully, or use an explicitly requested image-first design workflow when visual references add material value. Skip ordinary frontend work, simple forms, bugs, backend tasks, and UI already defined by the design system.
---

# Visual reference to implementation

Adapted from the pinned Taste image-to-code skill. Use the user's supplied visual reference as the visual source of truth; do not generate a replacement or let Taste override it.

## Supplied reference
1. Inspect the actual image. If it is unavailable, request the missing reference instead of inventing its contents.
2. Read relevant system-knowledge and existing source/components. Map the reference's hierarchy, layout, type scale, spacing, colors, imagery, borders, radii, and controls to the current design system.
3. Preserve visible text and structure where requested. Identify uncertain details instead of pretending pixel-perfect measurement; use project conventions for unspecified behavior and responsive states.
4. Implement reusable components in the existing framework. The screenshot does not define API contracts, permissions, or new business rules.
5. Open the running UI at comparable viewport dimensions, capture an affected-area screenshot, compare it to the reference, fix material differences, and re-check. Also check relevant narrow-width behavior and interaction states. Do not claim fidelity without seeing the result.

## Generated references
Generate references only when explicitly requested or when a new visually important surface lacks sufficient visual direction and generating a reference materially helps. Existing components/design-system coverage usually make it unnecessary.

Use an available image-generation capability according to its own instructions; this skill does not install one or require a personal API key. If generation is unavailable, explain the missing capability and continue source-image analysis or other independent work. Never claim an image was generated when it was not.

Create the smallest readable set that resolves the design uncertainty. Add section/detail images only if they resolve a specific missing detail; no mandatory image-per-section quota or repeated regeneration loop. Keep any generated reference consistent with the application, and obtain a usable visual before implementation when the requested workflow requires image-first.

[Original upstream reference](UPSTREAM.md) is retained for provenance and optional extraction guidance (sections 8–9 and 21–28); its mandatory generation, image-count, and redesign rules do not override the supplied-reference workflow above. Do not load the entire reference for normal screenshot work.

Use Playwright for targeted visual/behavioral verification; use Web Design Guidelines only when quality review adds value. Images are not evidence that authentication, business rules, or APIs work. Update system-knowledge only for implemented behavior changes.
