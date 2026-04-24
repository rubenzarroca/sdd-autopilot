#!/usr/bin/env node
// Copies runtime JSON assets next to the bundled dist/index.js.
// The engine resolves these via __dirname at runtime, so they must sit
// in the same directory as the executed script.

import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const engineDir = resolve(__dirname, '..');
const distDir = resolve(engineDir, 'dist');

mkdirSync(distDir, { recursive: true });

for (const asset of ['contracts.json', 'tools-manifest.json']) {
  copyFileSync(resolve(engineDir, 'src', asset), resolve(distDir, asset));
  console.log(`copied ${asset} -> dist/`);
}
