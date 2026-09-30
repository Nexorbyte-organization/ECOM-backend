import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('demo seed CLI executes on this platform and reports database failures', () => {
  const script = fileURLToPath(new URL('../scripts/seed-demo-data.js', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    cwd: path.dirname(path.dirname(script)),
    env: {
      ...process.env,
      PG_URI: 'postgres://seed_test:seed_test@127.0.0.1:1/seed_test',
      PG_SSL: 'false',
      SEED_ADMIN_EMAIL: 'seed-test@example.com',
      SEED_ADMIN_PASSWORD: 'unique-test-password-123',
      SEED_DEMO_CLEANUP: 'false',
    },
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Failed to seed admin account:.*ConnectionRefusedError/s);
});
