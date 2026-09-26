---
name: playwright-cli
description: Verify meaningful frontend workflows, forms, modals, navigation, permissions, responsive behavior, or important UI regressions in a running browser using the pinned local Playwright CLI. Skip full browser flows for trivial text/style changes unless explicitly requested.
---

# Targeted browser verification

Use the repository's pinned CLI through `node .agents/tools/playwright/run.mjs`. No global CLI or MCP registration is needed. See [team setup](../../tools/playwright/SETUP.md) if local dependencies/browser binaries are missing. Do not auto-install global tools or mutable @latest packages.

## Proportional workflow
1. Read relevant system-knowledge and source; select the affected flow, expected result, test-data needs, roles, and relevant viewport.
2. Start or use the appropriate local/test application with its normal documented command. A backend checkout contains no frontend server; obtain its URL from the task rather than assuming a sibling checkout. In a frontend checkout, the usual local dev command is `npm run dev` and port 3001.
3. Create a named isolated browser session. Observe a current snapshot before using element refs; refs can change after navigation/rendering.
4. Exercise the actual controls and assert the expected outcome. Cover relevant validation/error/loading/empty states, permissions, keyboard behavior, and responsive layout; do not run an entire suite for a local change.
5. Inspect relevant console/network failures. Fix defects within scope and repeat the affected check.
6. Close only the session created for this task. Report what was exercised, observable evidence, and any blocked checks.

Example from the repository root:
```sh
node .agents/tools/playwright/run.mjs -s=feature-check open http://localhost:3001
node .agents/tools/playwright/run.mjs -s=feature-check snapshot
node .agents/tools/playwright/run.mjs -s=feature-check click <ref-from-current-snapshot>
node .agents/tools/playwright/run.mjs -s=feature-check screenshot --filename=.playwright-cli/feature-check.png
node .agents/tools/playwright/run.mjs -s=feature-check close
```

Replace placeholder refs only with observed refs. A screenshot verifies appearance, not API correctness. A mocked response verifies client handling, not a real backend integration. Keep verification claims precise.

## Commands and optional references
Run the wrapper with `--help` for supported commands. [Pinned upstream commands](UPSTREAM.md) cover snapshot/find, fill/click, resize, screenshots, console/network, and named sessions. Every example using `playwright-cli` means the local wrapper here.
Read only what the task needs:
- [Sessions](references/session-management.md)
- [Code execution](references/running-code.md)
- [Mocks](references/request-mocking.md)
- [Tracing](references/tracing.md)
- [Video](references/video-recording.md)
- [Test runner](references/playwright-tests.md) only if an existing runner is relevant
- [Test generation](references/test-generation.md) only if durable tests are requested/justified
- [Attributes](references/element-attributes.md)

## Project overrides and data
Use isolated test sessions/data; do not attach to a personal browser or use persistent profiles by default. Login/session state is local and must not be committed or printed. If needed, store exported auth state only in ignored .playwright-cli/. Do not run cookie-get/token-printing examples or expose credentials in shell logs.

Browser artifacts remain local in ignored .playwright-cli/. Screenshots/traces may contain personal or sensitive application data; review before any requested publication. Upstream upload/PR examples do not authorize external messages or uploads. No automatic kill-all/close-all: preserve other developers' sessions.

No redundant MCP setup is installed. A separate Playwright test suite is not created by this skill; add durable tests only for meaningful regression coverage.
