#!/usr/bin/env node
// Compute SHA-256 hash of TOOLS array for versioning

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const engineDir = resolve(__dirname, '..');

// Import TOOLS from the built index.js
process.env.SDD_SKIP_MAIN = '1';
import { pathToFileURL } from 'node:url';
const { TOOLS } = await import(pathToFileURL(resolve(engineDir, 'build', 'index.js')).href);

// Deterministic serialization (keys sorted)
const sortKeys = (obj) => {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, key) => {
      acc[key] = sortKeys(obj[key]);
      return acc;
    }, {});
  }
  return obj;
};

const serialized = JSON.stringify(sortKeys(TOOLS));
const hash = createHash('sha256').update(serialized).digest('hex');

// Read version from package.json
const pkg = JSON.parse(readFileSync(resolve(engineDir, 'package.json'), 'utf-8'));

const manifest = {
  tools_hash: hash,
  tools_count: TOOLS.length,
  version: pkg.version,
  computed_at: new Date().toISOString(),
};

writeFileSync(resolve(engineDir, 'src', 'tools-manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
console.log(`Tools manifest: ${TOOLS.length} tools, hash=${hash.slice(0, 12)}...`);
