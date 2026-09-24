#!/usr/bin/env node
/** Explicit user-run helper. Never invoked by the conflict resolver or its tests. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
function exec(bin, args, { allowFailure = false } = {}) {
  const result = spawnSync(bin, args, { cwd: root, shell: false, windowsHide: true, encoding: 'utf8', timeout: 120000 });
  if (result.error) throw new Error(`${bin}: ${result.error.message}. Install Git/GitHub CLI and authenticate with gh auth login first.`);
  if (result.signal) throw new Error(`${bin} was interrupted: ${result.signal}`);
  if (result.status !== 0 && !allowFailure) throw new Error(`${bin} failed: ${result.stderr.trim()}`);
  return result;
}
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--public')) throw new Error('Usage: node scripts/publish.mjs [--public] (creates Ga-hou/git-conflict-resolver; defaults to PRIVATE)');
  const isPrivate = args[0] !== '--public';
  const owner = exec('gh', ['api', 'user', '--jq', '.login']).stdout.trim();
  if (owner.toLowerCase() !== 'ga-hou') throw new Error(`Expected authenticated personal account Ga-hou, got ${owner}; no repository was created.`);
  const target = 'Ga-hou/git-conflict-resolver';
  const existing = exec('gh', ['api', `repos/${target}`], { allowFailure: true });
  if (existing.status === 0) throw new Error(`${target} already exists; refusing to modify it or choose another name automatically.`);
  if (!/HTTP 404|Not Found/i.test(existing.stderr)) throw new Error(`Cannot verify that target is absent: ${existing.stderr.trim()}`);
  if (fs.existsSync(path.join(root, '.git'))) {
    const actualRoot = fs.realpathSync(exec('git', ['rev-parse', '--show-toplevel']).stdout.trim());
    if (actualRoot !== root) throw new Error('Working directory belongs to a different repository');
    const remotes = exec('git', ['remote']).stdout.trim();
    if (remotes) throw new Error('Local checkout already has a remote; review it manually before publishing');
    if (exec('git', ['status', '--porcelain']).stdout.trim()) throw new Error('Existing local repository is dirty; review and commit it before publishing');
    exec('git', ['rev-parse', '--verify', 'HEAD']);
  } else {
    const name = exec('git', ['config', '--get', 'user.name'], { allowFailure: true }).stdout.trim();
    const email = exec('git', ['config', '--get', 'user.email'], { allowFailure: true }).stdout.trim();
    if (!name || !email) throw new Error('Configure your Git user.name and user.email before publishing; no identity is invented for you.');
    exec('git', ['init', '-b', 'main']);
    exec('git', ['add', '--', '.gitattributes', '.gitignore', '.github', 'AGENTS.md', 'LICENSE', 'README.md', 'README-zh.md', 'RESEARCH.md', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'VERIFICATION.md', 'package.json', 'scripts', 'skills', 'test', 'verification']);
    exec('git', ['commit', '-m', 'feat: add v0.2 word-level conflict skill with partial resolution']);
  }
  const result = exec('gh', ['repo', 'create', target, isPrivate ? '--private' : '--public', '--source', root, '--remote', 'origin', '--push',
    '--description', 'Cross-platform Git conflict Skill: conservative scripts, intent-aware agents, history-safe submodule pins']);
  console.log(result.stdout.trim());
  const metadata = JSON.parse(exec('gh', ['api', `repos/${target}`]).stdout);
  if (metadata.private !== isPrivate) throw new Error(`Unexpected visibility: repository is not ${isPrivate ? 'private' : 'public'}. Review GitHub settings immediately.`);
  console.log(JSON.stringify({ created: true, repository: metadata.full_name, private: metadata.private, url: metadata.html_url }, null, 2));
} catch (e) {
  console.error(e.message);
  console.error('No force push or automatic overwrite was attempted. A failed remote operation may need manual inspection before retrying.');
  process.exitCode = 1;
}
