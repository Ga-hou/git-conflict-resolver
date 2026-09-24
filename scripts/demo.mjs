#!/usr/bin/env node
/** A real-Git two-hunk demonstration in an isolated temporary repository. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { main } from '../skills/git-conflict-resolver/scripts/resolve.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-conflict-demo-'));
const originalEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
try {
  process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'empty-global-config');
  process.env.GIT_CONFIG_NOSYSTEM = '1'; fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  function git(args, ok = true) {
    const r = spawnSync('git', ['-C', repo, ...args], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 20_000 });
    if (ok) assert.equal(r.status, 0, r.stderr || r.error?.message);
    return r;
  }
  git(['init', '-b', 'main']);
  for (const [k,v] of [['user.name','Demo fixture'], ['user.email','demo@example.invalid'], ['core.autocrlf','false'], ['commit.gpgsign','false']]) git(['config', k, v]);
  const b = 'const options = { retries: 2, timeout: 1000 };\n';
  const a = b.replace('retries: 2', 'retries: 3'), c = b.replace('timeout: 1000', 'timeout: 2000');
  const expected = a.replace('timeout: 1000', 'timeout: 2000');
  const gap = Array.from({length: 12}, (_,i) => `// unchanged ${i}\n`).join('');
  const file = path.join(repo, 'config.ts');
  const commit = (content, message) => { fs.writeFileSync(file, content); git(['add', 'config.ts']); git(['commit', '-m', message]); };
  commit(b + gap + 'mode = "base";\n', 'base'); git(['switch', '-c', 'topic']);
  commit(c + gap + 'mode = "theirs";\n', 'theirs: timeout plus behavior choice'); git(['switch', 'main']);
  commit(a + gap + 'mode = "ours";\n', 'ours: retries plus behavior choice');
  assert.equal(git(['merge', '--no-ff', '--no-commit', 'topic'], false).status, 1);
  const before = fs.readFileSync(file, 'utf8'), indexBefore = git(['ls-files', '-u', '-z']).stdout;
  const result = main(['run', '--repo', repo]);
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.startsWith(expected)); assert.equal(git(['ls-files', '-u', '-z']).stdout, indexBefore);
  const counts = text => (text.match(/^<{7,} /gm) || []).length;
  assert.equal(counts(before), 2); assert.equal(counts(after), 1);
  console.log(JSON.stringify({ version: '0.2.0', node: process.version, platform: process.platform,
    git: git(['--version']).stdout.trim(), genuineNativeGitConflict: true,
    beforeConflictBlocks: counts(before), afterConflictBlocks: counts(after),
    simpleHunksResolved: result.results[0].resolvedHunks, indexRemainsUnmerged: true,
    combinedFirstLine: after.split('\n')[0], remainingConflict: 'competing mode values',
    verified: true, semanticsVerified: false }, null, 2));
} finally {
  for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
