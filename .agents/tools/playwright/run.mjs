import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolRoot, '../../..');
const installBrowser = process.argv[2] === '--install-browser';
const entry = path.join(toolRoot, 'node_modules', installBrowser ? 'playwright/cli.js' : '@playwright/cli/playwright-cli.js');
if (!existsSync(entry)) {
  console.error('Missing local Playwright dependencies. Run: npm --prefix .agents/tools/playwright ci --ignore-scripts');
  process.exit(1);
}
const args = installBrowser ? ['install', 'chromium'] : process.argv.slice(2);
const result = spawnSync(process.execPath, [entry, ...args], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(toolRoot, '.browsers'), NO_UPDATE_NOTIFIER: '1' },
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
