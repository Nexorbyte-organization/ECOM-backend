import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAlterSchema } from '../db/sync-policy.js';

test('schema alteration requires an explicit local development opt-in', () => {
  assert.equal(shouldAlterSchema({ APP_ENV: 'dev' }), false);
  assert.equal(shouldAlterSchema({ APP_ENV: 'dev', DB_SYNC_ALTER: 'true' }), true);
  assert.equal(shouldAlterSchema({ APP_ENV: 'dev', DB_SYNC_ALTER: 'true', NODE_ENV: 'production' }), false);
  assert.equal(shouldAlterSchema({ APP_ENV: 'dev', DB_SYNC_ALTER: 'true', VERCEL: '1' }), false);
  assert.equal(shouldAlterSchema({ APP_ENV: 'prod', DB_SYNC_ALTER: 'true' }), false);
});