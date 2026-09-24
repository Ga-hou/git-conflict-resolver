import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, parseIndex } from '../skills/git-conflict-resolver/scripts/resolve.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-suite-'));
process.env.GIT_CONFIG_GLOBAL = path.join(temp, 'empty-config');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_TERMINAL_PROMPT = '0';
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n    name = Fixture\n    email = fixture@example.invalid\n');
test.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
function g(repo, args, input, ok = true) {
  const r = spawnSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', shell: false, windowsHide: true, timeout: 20000 });
  if (ok) assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr || r.error || ''}`);
  return r;
}
const gt = (repo, args) => g(repo, args).stdout.trim();
function dir(label) { return fs.mkdtempSync(path.join(temp, label)); }
function init(label = 'repo ', extra = []) {
  const repo = dir(label);
  g(repo, ['init', '-b', 'main', ...extra]);
  g(repo, ['config', 'user.name', 'Fixture']); g(repo, ['config', 'user.email', 'fixture@example.invalid']);
  g(repo, ['config', 'core.autocrlf', 'false']); g(repo, ['config', 'commit.gpgsign', 'false']);
  return repo;
}
function put(repo, file, content) { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), content); }
function commit(repo, message) { g(repo, ['add', '--all']); g(repo, ['commit', '-m', message]); return gt(repo, ['rev-parse', 'HEAD']); }
const index = repo => gt(repo, ['ls-files', '-u']);
const run = (repo, command = 'run', ...options) => main([command, '--repo', repo, ...options]);
const manifest = result => JSON.parse(fs.readFileSync(path.join(result.context, 'manifest.json'), 'utf8'));
function conflict(name = 'file.txt', binary = false) {
  const repo = init('中文 repo ');
  const data = s => binary ? Buffer.from(`first\0${s}\0last`) : `first\n${s}\nlast\n`;
  put(repo, name, data('base')); const base = commit(repo, 'base behavior');
  g(repo, ['switch', '-c', 'topic']); put(repo, name, data('theirs')); const theirs = commit(repo, 'theirs: add validation');
  g(repo, ['switch', 'main']); put(repo, name, data('ours')); const ours = commit(repo, 'ours: retain caching');
  assert.equal(g(repo, ['merge', '--no-ff', '--no-commit', 'topic'], undefined, false).status, 1);
  return { repo, base, ours, theirs, name };
}
function setStages(repo, name, base, ours, theirs, mode = '100644') {
  const zero = '0'.repeat(ours.length);
  let data = `0 ${zero}\t${name}\0`;
  for (const [s, oid] of [[1, base], [2, ours], [3, theirs]]) if (oid) data += `${mode} ${oid} ${s}\t${name}\0`;
  g(repo, ['update-index', '-z', '--index-info'], data);
}
function cleanConflict({ crlf = false, sha256 = false } = {}) {
  const repo = init('clean ', sha256 ? ['--object-format=sha256'] : []), name = 'file.txt';
  put(repo, name, 'one\na\nb\nc\ntwo\n'); const base = commit(repo, 'base');
  g(repo, ['switch', '-c', 'topic']); put(repo, name, 'one\na\nb\nc\nTWO\n'); const theirs = commit(repo, 'change end');
  g(repo, ['switch', 'main']); put(repo, name, 'ONE\na\nb\nc\ntwo\n'); const ours = commit(repo, 'change start');
  g(repo, ['update-ref', 'AUTO_MERGE', `${ours}^{tree}`]);
  setStages(repo, name, gt(repo, ['rev-parse', `${base}:${name}`]), gt(repo, ['rev-parse', `${ours}:${name}`]), gt(repo, ['rev-parse', `${theirs}:${name}`]));
  if (crlf) { g(repo, ['config', 'core.autocrlf', 'true']); put(repo, name, 'ONE\r\na\r\nb\r\nc\r\ntwo\r\n'); }
  return { repo, name, base, ours, theirs };
}
function submoduleConflict() {
  const source = init('source ');
  put(source, 'f.txt', 'base\n'); const base = commit(source, 'child base');
  g(source, ['switch', '-c', 'ours']); put(source, 'f.txt', 'ours\n'); const ours = commit(source, 'child caching intent');
  g(source, ['switch', '-c', 'theirs', base]); put(source, 'f.txt', 'theirs\n'); const theirs = commit(source, 'child validation intent');
  g(source, ['switch', 'main']);
  const repo = init('parent '), name = 'modules/子 模块', child = path.join(repo, name);
  g(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, name]); commit(repo, 'add child base');
  g(child, ['config', 'user.name', 'Fixture']); g(child, ['config', 'user.email', 'fixture@example.invalid']); g(child, ['config', 'core.autocrlf', 'false']);
  g(repo, ['switch', '-c', 'topic']); g(child, ['switch', '--detach', theirs]); commit(repo, 'parent advances validation');
  g(repo, ['switch', 'main']); g(child, ['switch', '--detach', ours]); commit(repo, 'parent advances caching');
  assert.equal(g(repo, ['merge', '--no-ff', '--no-commit', 'topic'], undefined, false).status, 1);
  return { repo, source, name, child, base, ours, theirs };
}

test('parses NUL index records, Unicode, whitespace and 64-character object IDs', () => {
  const oid = 'a'.repeat(64), name = '-[x]\t中文\nfile';
  const result = parseIndex(Buffer.from(`100644 ${oid} 2\t${name}\0`));
  assert.equal(result[0].path, name); assert.equal(result[0].stages['2'].oid, oid);
});
test('real merge keeps both intents and stages; emits base, patches and full messages', () => {
  const { repo, name } = conflict(); const before = index(repo), work = fs.readFileSync(path.join(repo, name));
  const r = run(repo), m = manifest(r), folder = path.join(r.context, 'files', m.files[0].id);
  assert.deepEqual(r.remaining, [name]); assert.equal(index(repo), before);
  assert.deepEqual(fs.readFileSync(path.join(repo, name)), work);
  assert.match(fs.readFileSync(path.join(folder, 'candidate.diff3'), 'utf8'), /BASE/);
  assert.match(fs.readFileSync(path.join(folder, '1.blob'), 'utf8'), /base/);
  assert.match(fs.readFileSync(path.join(folder, 'ours.commits.patch'), 'utf8'), /retain caching/);
  assert.match(fs.readFileSync(path.join(folder, 'theirs.commits.patch'), 'utf8'), /add validation/);
});
test('prepare is idempotent and preserves original worktree backup', () => {
  const { repo, name } = conflict(); const first = run(repo, 'prepare');
  put(repo, name, 'human resolution\n'); const next = run(repo, 'prepare');
  assert.equal(first.context, next.context);
  assert.match(fs.readFileSync(path.join(first.context, 'files', manifest(first).files[0].id, 'worktree.before'), 'utf8'), /<<<<<<< HEAD/);
});
test('never overwrites edits made before prepare', () => {
  const { repo, name } = cleanConflict(); put(repo, name, 'human work\n');
  const r = run(repo); assert.match(r.results[0].reason, /preserve/);
  assert.equal(fs.readFileSync(path.join(repo, name), 'utf8'), 'human work\n'); assert.ok(index(repo));
});
test('never overwrites edits made after prepare', () => {
  const { repo, name } = cleanConflict(); run(repo, 'prepare'); put(repo, name, 'human work\n');
  const r = run(repo, 'auto'); assert.match(r.results[0].reason, /changed since/);
  assert.equal(fs.readFileSync(path.join(repo, name), 'utf8'), 'human work\n');
});
test('applies only a clean native merge, preserving both changes', () => {
  const { repo, name } = cleanConflict(); const r = run(repo);
  assert.equal(r.results[0].status, 'resolved'); assert.equal(index(repo), '');
  assert.equal(gt(repo, ['show', `:0:${name}`]), 'ONE\na\nb\nc\nTWO'); assert.equal(run(repo, 'verify').ok, true);
});
test('preserves CRLF worktree and canonical LF staged blob', () => {
  const { repo, name } = cleanConflict({ crlf: true }); run(repo);
  assert.equal(index(repo), '');
  assert.equal(fs.readFileSync(path.join(repo, name), 'utf8'), 'ONE\r\na\r\nb\r\nc\r\nTWO\r\n');
  assert.equal(g(repo, ['show', `:0:${name}`]).stdout, 'ONE\na\nb\nc\nTWO\n');
});
test('supports SHA-256 repositories', () => {
  const { repo } = cleanConflict({ sha256: true }); const r = run(repo);
  assert.equal(r.results[0].oid.length, 64); assert.equal(run(repo, 'verify').ok, true);
});
test('binary conflicts stay unresolved', () => {
  const { repo, name } = conflict('image.bin', true); const before = fs.readFileSync(path.join(repo, name));
  const r = run(repo); assert.deepEqual(r.remaining, [name]); assert.deepEqual(fs.readFileSync(path.join(repo, name)), before);
});
test('leading dash, brackets, spaces and Unicode names are literal, not shell patterns', () => {
  const { repo, name } = conflict('-[中文] file.txt'); const r = run(repo);
  assert.deepEqual(r.remaining, [name]); assert.equal(manifest(r).files[0].path, name);
});
test('newline filenames survive snapshotting on POSIX', { skip: process.platform === 'win32' }, () => {
  const { repo, name } = conflict('odd\nname.txt'); assert.deepEqual(run(repo).remaining, [name]);
});
test('custom merge attributes are not bypassed', () => {
  const { repo, name } = cleanConflict(); put(repo, '.gitattributes', `${name} merge=custom\n`);
  const before = index(repo); const r = run(repo); assert.equal(index(repo), before); assert.equal(r.remaining.length, 1);
});
test('missing AUTO_MERGE proof disables automatic writes', () => {
  const { repo } = cleanConflict(); g(repo, ['update-ref', '-d', 'AUTO_MERGE']);
  assert.match(run(repo).results[0].reason, /pristine/); assert.ok(index(repo));
});
test('add/add without a base is classified for manual resolution', () => {
  const { repo, name, ours, theirs } = cleanConflict();
  setStages(repo, name, null, gt(repo, ['rev-parse', `${ours}:${name}`]), gt(repo, ['rev-parse', `${theirs}:${name}`]));
  const r = run(repo); assert.equal(manifest(r).files[0].type, 'manual'); assert.deepEqual(r.remaining, [name]);
});
test('detects index mutation after snapshot', () => {
  const { repo, name, ours, theirs } = cleanConflict(); run(repo, 'prepare');
  const o = gt(repo, ['rev-parse', `${ours}:${name}`]), t = gt(repo, ['rev-parse', `${theirs}:${name}`]);
  setStages(repo, name, t, o, t); assert.throws(() => run(repo, 'auto'), /Index changed/);
  assert.throws(() => run(repo, 'prepare'), /Conflict index changed/);
});
test('verification fails before resolution and succeeds after staging actual result', () => {
  const { repo, name } = conflict(); run(repo); assert.equal(run(repo, 'verify').ok, false);
  put(repo, name, 'first\ncaching plus validation\nlast\n'); g(repo, ['add', '--', name]);
  assert.equal(run(repo, 'verify').ok, true);
  put(repo, name, 'further unstaged edit\n'); assert.equal(run(repo, 'verify').ok, false);
});
test('staging conflict markers does not count as resolution', () => {
  const { repo, name } = conflict(); run(repo); g(repo, ['add', '--', name]);
  const r = run(repo, 'verify'); assert.equal(r.ok, false); assert.match(r.errors.join('\n'), /markers|check/);
});
test('an aborted or continued operation invalidates its old session', () => {
  const { repo } = conflict(); run(repo); g(repo, ['merge', '--abort']);
  assert.throws(() => run(repo, 'verify'), /operation changed/);
});
test('rebase identifies stage roles and the exact replayed commit', () => {
  const { repo, name, theirs } = conflict(); g(repo, ['merge', '--abort']); g(repo, ['switch', 'topic']);
  assert.equal(g(repo, ['rebase', 'main'], undefined, false).status, 1);
  const r = run(repo, 'prepare'), m = manifest(r);
  assert.equal(m.operation.kind, 'rebase'); assert.equal(m.operation.replay, theirs);
  assert.match(m.operation.roles.ours, /already-rebased/);
  assert.equal(fs.readFileSync(path.join(r.context, 'files', m.files[0].id, '2.blob'), 'utf8'), 'first\nours\nlast\n');
  assert.equal(m.files[0].path, name);
});
test('cherry-pick context uses the replayed commit, not a guessed merge base', () => {
  const { repo, theirs } = conflict(); g(repo, ['merge', '--abort']);
  assert.equal(g(repo, ['cherry-pick', theirs], undefined, false).status, 1);
  const m = manifest(run(repo, 'prepare')); assert.equal(m.operation.kind, 'cherry-pick'); assert.equal(m.operation.other, theirs);
});
test('linked worktrees use their own actual Git directory and accept a subdirectory cwd', () => {
  const { repo } = conflict(); g(repo, ['merge', '--abort']);
  const worktree = path.join(dir('worktree parent '), 'linked');
  g(repo, ['worktree', 'add', '-b', 'worktree-test', worktree, 'main']);
  assert.equal(g(worktree, ['merge', '--no-ff', '--no-commit', 'topic'], undefined, false).status, 1);
  fs.mkdirSync(path.join(worktree, 'inside'));
  const r = run(path.join(worktree, 'inside'), 'prepare');
  assert.ok(r.context.includes(`${path.sep}worktrees${path.sep}`));
  assert.equal(manifest(r).repository, fs.realpathSync(worktree));
});
test('submodule divergence merges locally, keeps parent conflict, and pins only after commit', () => {
  const { repo, child, name, ours, theirs } = submoduleConflict(); run(repo);
  const r = run(repo, 'submodule-prepare', '--path', name);
  assert.equal(r.parentStillUnmerged, true); assert.ok(index(repo)); assert.ok(index(child));
  run(child); put(child, 'f.txt', 'caching plus validation\n'); g(child, ['add', 'f.txt']);
  assert.equal(run(child, 'verify').ok, true);
  assert.throws(() => run(repo, 'submodule-pin', '--path', name, '--reviewed'), /local changes|operation/);
  commit(child, 'merge both intents');
  const pin = run(repo, 'submodule-pin', '--path', name, '--reviewed');
  assert.equal(pin.published, false); assert.equal(index(repo), '');
  g(child, ['merge-base', '--is-ancestor', ours, pin.pinned]); g(child, ['merge-base', '--is-ancestor', theirs, pin.pinned]);
  assert.equal(run(repo, 'verify').ok, true);
});
test('submodule preparation resumes without resetting partially resolved work', () => {
  const { repo, child, name } = submoduleConflict(); run(repo); run(repo, 'submodule-prepare', '--path', name);
  put(child, 'f.txt', 'partial human edit\n');
  const r = run(repo, 'submodule-prepare', '--path', name);
  assert.equal(r.status, 'needs-agent-or-commit'); assert.equal(fs.readFileSync(path.join(child, 'f.txt'), 'utf8'), 'partial human edit\n');
});
test('dirty submodule is not switched, reset or staged', () => {
  const { repo, child, name } = submoduleConflict(); run(repo); put(child, 'local.txt', 'keep me\n');
  const before = gt(child, ['rev-parse', 'HEAD']);
  assert.throws(() => run(repo, 'submodule-prepare', '--path', name), /local changes/);
  assert.equal(gt(child, ['rev-parse', 'HEAD']), before); assert.ok(index(repo));
});
test('retains committed local descendants as the submodule merge start', () => {
  const { repo, child, name } = submoduleConflict(); put(child, 'local.txt', 'local intent\n'); const local = commit(child, 'local work');
  run(repo); const r = run(repo, 'submodule-prepare', '--path', name); assert.equal(r.start, local);
  put(child, 'f.txt', 'both\n'); commit(child, 'merge');
  const pin = run(repo, 'submodule-pin', '--path', name, '--reviewed'); g(child, ['merge-base', '--is-ancestor', local, pin.pinned]);
});
test('pin requires explicit review, never picks one divergent side', () => {
  const { repo, name } = submoduleConflict(); run(repo);
  assert.throws(() => run(repo, 'submodule-pin', '--path', name), /--reviewed/);
  assert.throws(() => run(repo, 'submodule-pin', '--path', name, '--reviewed'), /does not include stage 3/);
});
test('verification catches manually accepting only the local gitlink', () => {
  const { repo, name } = submoduleConflict(); run(repo); g(repo, ['add', '--', name]);
  const r = run(repo, 'verify'); assert.equal(r.ok, false); assert.match(r.errors.join('\n'), /discards stage 3/);
});
test('fast-forward submodule selects a descendant, not a timestamp, and still defers pinning', () => {
  const { repo, child, name, ours } = submoduleConflict();
  put(child, 'more.txt', 'new\n'); const descendant = commit(child, 'descendant');
  g(child, ['switch', '--detach', ours]); setStages(repo, name, ours, ours, descendant, '160000');
  run(repo); const r = run(repo, 'submodule-prepare', '--path', name);
  assert.equal(r.candidate, descendant); assert.ok(index(repo)); assert.equal(gt(child, ['rev-parse', 'HEAD']), descendant);
  run(repo, 'submodule-pin', '--path', name, '--reviewed'); assert.equal(run(repo, 'verify').ok, true);
});
test('shallow histories are blocked instead of being called divergent', () => {
  const { repo, child, name, ours } = submoduleConflict(); run(repo);
  fs.writeFileSync(gt(child, ['rev-parse', '--git-path', 'shallow']), `${ours}\n`);
  assert.throws(() => run(repo, 'submodule-prepare', '--path', name), /Shallow/);
});
test('missing submodule objects do not cause an arbitrary pin', () => {
  const { repo, name, base, ours } = submoduleConflict();
  setStages(repo, name, base, ours, '1'.repeat(40), '160000'); run(repo);
  assert.throws(() => run(repo, 'submodule-prepare', '--path', name), /Missing submodule commit/); assert.ok(index(repo));
});
test('uninitialized submodule never falls through to operating on its parent', () => {
  const { repo, child, name } = submoduleConflict(); run(repo); fs.renameSync(path.join(child, '.git'), path.join(child, 'git-pointer.saved'));
  assert.throws(() => run(repo, 'submodule-prepare', '--path', name), /not initialized/); assert.ok(index(repo));
});
test('command lock prevents two resolver processes from writing together', () => {
  const { repo } = conflict(); run(repo, 'prepare');
  const lock = path.join(gt(repo, ['rev-parse', '--absolute-git-dir']), 'agent-conflict-resolver', 'command.lock');
  fs.writeFileSync(lock, 'fixture'); assert.throws(() => run(repo), /Another resolver/); fs.unlinkSync(lock);
});
test('CLI returns exit 2 for unresolved verification and valid JSON', () => {
  const { repo } = conflict(); run(repo);
  const script = fileURLToPath(new URL('../skills/git-conflict-resolver/scripts/resolve.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, 'verify', '--repo', repo], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.equal(JSON.parse(r.stdout).ok, false);
});

test('automatic staging leaves unrelated staged work untouched', () => {
  const { repo } = cleanConflict(); put(repo, 'unrelated.txt', 'do not touch\n'); g(repo, ['add', 'unrelated.txt']);
  const before = gt(repo, ['rev-parse', ':0:unrelated.txt']); run(repo);
  assert.equal(gt(repo, ['rev-parse', ':0:unrelated.txt']), before);
});
test('symlink conflicts remain manual and never write through the link', { skip: process.platform === 'win32' }, () => {
  const repo = init('symlink ');
  put(repo, 'a', 'a\n'); put(repo, 'b', 'b\n'); put(repo, 'c', 'c\n'); fs.symlinkSync('a', path.join(repo, 'link')); commit(repo, 'base');
  g(repo, ['switch', '-c', 'topic']); fs.unlinkSync(path.join(repo, 'link')); fs.symlinkSync('b', path.join(repo, 'link')); commit(repo, 'theirs');
  g(repo, ['switch', 'main']); fs.unlinkSync(path.join(repo, 'link')); fs.symlinkSync('c', path.join(repo, 'link')); commit(repo, 'ours');
  assert.equal(g(repo, ['merge', 'topic'], undefined, false).status, 1);
  const r = run(repo); assert.equal(manifest(r).files[0].type, 'manual');
  assert.equal(fs.readFileSync(path.join(repo, 'c'), 'utf8'), 'c\n'); assert.ok(index(repo));
});
test('submodule initialization with a verified local URL does not resolve the parent pointer', () => {
  const { repo, child, name, source } = submoduleConflict(); run(repo);
  fs.rmSync(child, { recursive: true, force: true });
  const r = run(repo, 'submodule-prepare', '--path', name, '--init', '--url', source);
  assert.equal(r.parentStillUnmerged, true); assert.ok(index(repo)); assert.ok(fs.existsSync(path.join(child, '.git')));
});
test('submodule checkout refuses to overwrite an ignored local file', () => {
  const { repo, child, name, ours } = submoduleConflict();
  put(child, '.gitignore', 'generated.txt\n'); const local = commit(child, 'ignore local generated file');
  g(child, ['switch', '--detach', ours]); put(child, 'generated.txt', 'remote tracked content\n'); const theirs = commit(child, 'track generated file');
  g(child, ['switch', '--detach', local]); put(child, 'generated.txt', 'valuable local content\n');
  setStages(repo, name, ours, local, theirs, '160000'); run(repo);
  assert.throws(() => run(repo, 'submodule-prepare', '--path', name), /ignored\/untracked local path/);
  assert.equal(fs.readFileSync(path.join(child, 'generated.txt'), 'utf8'), 'valuable local content\n');
});
test('installer copies a self-contained skill and refuses silent replacement', () => {
  const target = dir('install 中文 ');
  const script = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
  const first = spawnSync(process.execPath, [script, '--to', target], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const installed = path.join(target, 'git-conflict-resolver');
  assert.ok(fs.existsSync(path.join(installed, 'scripts/resolve.mjs')));
  const help = spawnSync(process.execPath, [path.join(installed, 'scripts/resolve.mjs'), 'help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.ok(JSON.parse(help.stdout).usage.length);
  const linked = path.join(target, 'linked-skill');
  fs.symlinkSync(installed, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedHelp = spawnSync(process.execPath, [path.join(linked, 'scripts/resolve.mjs'), 'help'], { encoding: 'utf8' });
  assert.equal(linkedHelp.status, 0, linkedHelp.stderr);
  assert.deepEqual(JSON.parse(linkedHelp.stdout), JSON.parse(help.stdout));
  const second = spawnSync(process.execPath, [script, '--to', target], { encoding: 'utf8' });
  assert.equal(second.status, 1); assert.match(second.stderr, /Destination exists/);
});
