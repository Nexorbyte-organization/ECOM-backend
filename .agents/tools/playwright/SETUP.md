# Shared frontend design and browser tools

## Installed capabilities and sources

Four separate skills live in `.agents/skills/`; each has a short project-specific entrypoint and an unchanged upstream source at `UPSTREAM.md`. Only relevant references are loaded. Neither system-knowledge nor solution-architect is replaced.

- gpt-taste and image-to-code: [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), commit ce26fc25c0e5e8cab638f883de62d9a86ee5e45b; MIT. Only GPT Taste is installed, not overlapping Taste variants.
- web-design-guidelines: [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills), commit 063bee94c3f4df8453406c830b0a7df0f2860278, metadata version 1.0.0; upstream README declares MIT.
- Guidelines snapshot: [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines), commit e3d624baaf29dc1fc645aff3e38f03e564d2d6b1; MIT.
- playwright-cli skill: [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli), commit 74354ecc7a43da16d91a9bc54fa8db8283a3fcf5; Apache-2.0.
- Runtime: @playwright/cli 0.1.21, exact package version and dependency integrity pinned by this tool's package-lock.json. Its published dependencies are Playwright/Playwright Core 1.64.0-alpha-1789764292000; this is the dependency declared by the current CLI release, not an independently selected test runner.

[Official Codex docs](https://learn.chatgpt.com/docs/build-skills) support repository-root .agents/skills. [Taste upstream](https://github.com/Leonxlnx/taste-skill) supports copying portable skill files. Installation used the Codex skill-installer with explicit repository destinations and immutable commits, after source inspection. [Playwright docs](https://playwright.dev/docs/getting-started-cli) support a local npm dependency and recommend CLI skills for token-efficient coding-agent work.

The CLI is isolated in this tooling package; application package.json, application lockfiles, and application functionality are unchanged. No global install, MCP server, extension, or account-specific registration is configured. Both application repositories carry self-contained copies so a clone does not depend on a sibling checkout.

## One-time setup on each machine

Install Node.js 20+ and npm. From this repository root:

```sh
npm --prefix .agents/tools/playwright ci --ignore-scripts
npm --prefix .agents/tools/playwright run browser:install
node .agents/tools/playwright/run.mjs --help
```

Browser installation downloads the pinned Chromium build into ignored `.agents/tools/playwright/.browsers/`. It is a local binary dependency, not something Git transfers. On Linux, missing OS libraries may require Playwright's documented host-dependency setup by the developer/administrator; do not silently alter the machine. Skill files themselves require no local installation or OpenAI account configuration.

Start the actual application separately using its normal setup. The frontend normally runs at port 3001. Backend clones contain no frontend UI server; supply a running frontend/test URL. Authenticated application verification requires suitable test accounts and configured backend services; do not store their values here.

Run all browser commands through the cross-platform Node wrapper, from the repository root. The wrapper uses the pinned local executable, preserves arguments, disables update notices, and selects the project browser cache. CLI reads tracked `.playwright/cli.config.json`: isolated Chromium, headless, 1280 × 800. Resize for affected responsive checks or use headed mode when useful. Named sessions avoid interfering with other tasks.

## Coordination and activation

Tiny text/style edit → direct implementation; knowledge only if needed.
Normal UI feature in an established pattern → relevant knowledge/components → implement → targeted browser check if useful.
Significant new visual page → knowledge → architecture only if complex → Taste → implement → guideline review/browser check.
Supplied screenshot → image-to-code → faithful implementation → browser screenshot comparison; Taste must not override it.
Complex multi-role workflow → architecture + relevant knowledge/source; design/browser skills only for the significant UI.

Matching is model-selected, not a guaranteed deterministic trigger engine. Scoped descriptions and AGENTS.md give every account the same routing rules.

## Conflicts resolved in local entrypoints

- GPT Taste's mandatory AIDA, simulated RNG, GSAP, fonts/icons, stock imagery, and huge spacing conflict with existing-system reuse. These are not mandatory here. Never fabricate tool execution.
- Image-to-Code's mandatory generation, one-image-per-section quota, and regeneration loop conflict with supplied-reference fidelity and context efficiency. Existing references win; generate only when it materially helps.
- Vercel's mutable fresh-fetch and unconditional scope question conflict with reproducible team baselines and inferable task scope. Use the pinned guideline snapshot and relevant sections. Report a newer source separately if requested.
- Playwright upstream global/@latest fallback, credential-dumping, session-wide cleanup, and PR-upload examples conflict with local pinning, private state, and other tasks' sessions. Use the wrapper, ignored local state, task-owned sessions, and explicitly authorized external actions only.

Image-to-Code requires an existing visual-analysis capability; generation, if requested/needed, requires an available image-generation tool. This package does not install an image service or share anyone's personal access.

## Git files

Commit AGENTS.md routing changes, `.gitignore`, `.playwright/cli.config.json`, complete `.agents/skills/gpt-taste/`, `image-to-code/`, `web-design-guidelines/`, `playwright-cli/`, and `.agents/tools/playwright/` excluding ignored dependencies/binaries. Sources.json records pins, licenses and hashes.

Never commit tooling node_modules, browser binaries, .playwright-cli artifacts, auth/storage state, profiles, credentials, personal machine paths, or environment files. Existing unrelated uncommitted changes should stay out of this installation commit.

## Updating

Review upstream source and commands before changing a pin. Replace the corresponding source snapshot, update provenance/hashes, and preserve project activation/override rules. Update the CLI version and tool lockfile together, then repeat help and browser smoke verification. Do not auto-update from mutable latest during feature work.
