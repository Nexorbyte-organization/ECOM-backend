/* eslint-disable no-console */
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * O-Ushers API — Documentation Generator
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads  : docs/openapi.yaml
 * Outputs: docs/openapi.json  ← import this file into APIdog
 *
 * Usage:
 *   npm run docs
 *   -- or --
 *   node docs/generate-docs.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── 1. Load YAML ──────────────────────────────────────────────────────────────
const yamlPath = resolve(__dirname, 'openapi.yaml');
const jsonPath = resolve(__dirname, 'openapi.json');

console.log('\n🔍  Reading openapi.yaml …');

let yamlText;
try {
  yamlText = readFileSync(yamlPath, 'utf8');
} catch (err) {
  console.error('❌  Cannot read openapi.yaml:', err.message);
  process.exit(1);
}

// ── 2. Parse YAML → JS object ─────────────────────────────────────────────────
let spec;
try {
  const jsyaml = require('js-yaml');
  spec = jsyaml.load(yamlText);
  console.log('✅  YAML parsed successfully');
} catch (err) {
  if (err.code === 'MODULE_NOT_FOUND') {
    console.error(
      '\n❌  js-yaml is not installed.\n' +
      '    Run:  npm install --save-dev js-yaml\n' +
      '    Then re-run:  npm run docs\n'
    );
  } else {
    console.error('❌  YAML parse error:', err.message);
  }
  process.exit(1);
}

// ── 3. Basic Validation ───────────────────────────────────────────────────────
console.log('\n🔎  Validating spec …');
const errors = [];

if (!spec.openapi)                          errors.push('Missing field: openapi');
if (!spec.info?.title)                      errors.push('Missing field: info.title');
if (!spec.info?.version)                    errors.push('Missing field: info.version');
if (!spec.paths || !Object.keys(spec.paths).length) errors.push('Missing field: paths');

if (errors.length > 0) {
  console.error('❌  Validation failed:');
  errors.forEach(e => console.error('   •', e));
  process.exit(1);
}
console.log('✅  Spec is valid');

// ── 4. Write JSON ─────────────────────────────────────────────────────────────
const jsonStr = JSON.stringify(spec, null, 2);
writeFileSync(jsonPath, jsonStr, 'utf8');
console.log(`\n📄  openapi.json written to: ${jsonPath}`);

// ── 5. Endpoint Summary Table ─────────────────────────────────────────────────
console.log('\n📋  Endpoint Summary\n');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
const tagGroups = {};

for (const [path, pathObj] of Object.entries(spec.paths)) {
  for (const method of HTTP_METHODS) {
    if (!pathObj[method]) continue;
    const op = pathObj[method];
    const tag = (op.tags && op.tags[0]) ? op.tags[0] : 'Untagged';
    if (!tagGroups[tag]) tagGroups[tag] = [];
    const isPublic = op.security && op.security.length === 0;
    tagGroups[tag].push({
      method: method.toUpperCase().padEnd(7),
      path,
      summary: op.summary || '—',
      authIcon: isPublic ? '🌐' : '🔒',
    });
  }
}

let totalEndpoints = 0;

for (const [tag, ops] of Object.entries(tagGroups)) {
  const header = `  ╔══  ${tag}  (${ops.length} endpoints)`;
  console.log(header);
  for (const op of ops) {
    const pathPadded = op.path.padEnd(50);
    console.log(`  ║  ${op.authIcon}  ${op.method} ${pathPadded}  ${op.summary}`);
  }
  console.log('  ╚' + '═'.repeat(78));
  totalEndpoints += ops.length;
}

console.log(`\n✨  Total: ${totalEndpoints} endpoints across ${Object.keys(tagGroups).length} tag groups`);
console.log('\n🔑  🔒 = Bearer token required    🌐 = Public (no auth)');
console.log('\n🚀  Import docs/openapi.json into APIdog to get your updated docs!\n');
