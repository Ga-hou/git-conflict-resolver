#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['.git', 'node_modules'].includes(entry.name)) return [];
    const p = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(p) : p.endsWith('.mjs') ? [p] : [];
  });
}
const scripts = walk(root);
for (const script of scripts) {
  const r = spawnSync(process.execPath, ['--check', script], { shell: false, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
const skill = fs.readFileSync(path.join(root, 'skills/git-conflict-resolver/SKILL.md'), 'utf8');
if (!/^---\r?\nname: git-conflict-resolver\r?\ndescription: .+\r?\n---/m.test(skill)) throw new Error('Missing skill frontmatter');
const vendor = path.join(root, 'skills/git-conflict-resolver/scripts/vendor');
const provenance = JSON.parse(fs.readFileSync(path.join(vendor, 'provenance.json'), 'utf8'));
for (const item of provenance.files) {
  if (!['node-diff3.mjs', 'node-diff3.LICENSE.md'].includes(item.path)) throw new Error('Unexpected vendored path');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(vendor, item.path))).digest('hex');
  if (actual !== item.sha256) throw new Error(`Vendored content changed without provenance update: ${item.path}`);
}
console.log(`Checked ${scripts.length} JavaScript files, skill metadata and vendored hashes.`);
