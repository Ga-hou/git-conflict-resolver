#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../skills/git-conflict-resolver/', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--to') {
  console.error('Usage: node scripts/install.mjs --to /absolute/path/to/agent/skills');
  process.exitCode = 1;
} else {
  try {
    const parent = path.resolve(args[1]);
    const target = path.join(parent, 'git-conflict-resolver');
    if (fs.existsSync(target)) throw new Error(`Destination exists: ${target}. Review/remove or move the old installation explicitly; it was not overwritten.`);
    if (target === source || target.startsWith(source + path.sep)) throw new Error('Destination cannot be inside the source skill');
    fs.mkdirSync(parent, { recursive: true });
    // Use Node's JS traversal to avoid the Windows Unicode-path copy bug: nodejs/node#61878.
    fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false, dereference: false, filter: () => true });
    console.log(JSON.stringify({ installed: true, directory: target, entry: path.join(target, 'SKILL.md') }, null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
