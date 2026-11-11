#!/usr/bin/env node
// Copy the JSON Schemas from a checkout of C2-POLY/compliance-spec into schemas/.
// Usage: node scripts/sync-schemas.mjs <path-to-compliance-spec>
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const source = process.argv[2];
if (!source) {
  console.error('Usage: node scripts/sync-schemas.mjs <path-to-compliance-spec>');
  process.exit(2);
}
const from = resolve(source, 'schema', 'v0.1');
const to = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'v0.1');
mkdirSync(to, { recursive: true });
const files = readdirSync(from).filter((f) => f.endsWith('.json'));
if (files.length === 0) {
  console.error(`No schema found in ${from}`);
  process.exit(1);
}
for (const f of files) copyFileSync(join(from, f), join(to, f));

let commit = 'unknown';
try {
  commit = execFileSync('git', ['-C', resolve(source), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  // not a git checkout: keep "unknown"
}
writeFileSync(join(to, '..', 'SOURCE.json'), `${JSON.stringify({ spec_version: '0.1', source: 'C2-POLY/compliance-spec', commit, files }, null, 2)}\n`);
console.log(`Synced ${files.length} schemas from ${from} (spec commit ${commit})`);
