import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../skills/git-conflict-resolver/scripts/resolve.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'refinement-v2-'));
process.env.GIT_CONFIG_GLOBAL = path.join(temp, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_TERMINAL_PROMPT = '0';
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
test.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
const base = 'const options = { retries: 2, timeout: 1000 };\n';
const ours = base.replace('retries: 2', 'retries: 3');
const theirs = base.replace('timeout: 1000', 'timeout: 2000');
const combined = ours.replace('timeout: 1000', 'timeout: 2000');
function g(repo, args, ok = true) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 20_000 });
  if (ok) assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  return r;
}
function fixture({ a = ours, b = base, c = theirs, file = '中文 file.ts', op = 'merge' } = {}) {
  const repo = fs.mkdtempSync(path.join(temp, 'repo '));
  g(repo, ['init', '-b', 'main']);
  for (const [k,v] of [['user.name', 'Fixture'], ['user.email','test@example.invalid'], ['core.autocrlf','false'], ['commit.gpgsign','false']]) g(repo, ['config', k, v]);
  const write = content => fs.writeFileSync(path.join(repo, file), content);
  const commit = msg => { g(repo, ['add', '--', file]); g(repo, ['commit', '-m', msg]); };
  write(b); commit('base'); g(repo, ['switch', '-c', 'topic']); write(c); commit('theirs: timeout intent');
  g(repo, ['switch', 'main']); write(a); commit('ours: retry intent');
  let args = ['merge', '--no-ff', '--no-commit', 'topic'];
  if (op === 'rebase') { g(repo, ['switch', 'topic']); args = ['rebase', 'main']; }
  if (op === 'cherry-pick') args = ['cherry-pick', 'topic'];
  assert.equal(g(repo, args, false).status, 1, 'fixture must be a REAL native Git conflict');
  return { repo, file, write, working: () => fs.readFileSync(path.join(repo, file), 'utf8') };
}
const run = (repo, cmd = 'run', ...args) => main([cmd, '--repo', repo, ...args]);
const unmerged = repo => g(repo, ['ls-files', '-u', '-z']).stdout;
const mf = r => JSON.parse(fs.readFileSync(path.join(r.context, 'manifest.json'), 'utf8'));
const separated = ({ simple = true } = {}) => {
  const gap = Array.from({ length: 12 }, (_, i) => `// unchanged separator ${i}\n`).join('');
  return fixture({ b: base + gap + 'mode = "base";\n',
    a: (simple ? ours : base) + gap + 'mode = "ours";\n',
    c: (simple ? theirs : base) + gap + 'mode = "theirs";\n' });
};
test('REAL merge: native conflict is solved by disjoint-token refinement', () => {
  const f = fixture(); assert.ok(unmerged(f.repo));
  const r = run(f.repo);
  assert.equal(r.results[0].status, 'resolved'); assert.equal(f.working(), combined);
  assert.equal(unmerged(f.repo), ''); assert.equal(r.summary.simpleHunksResolved, 1);
  assert.equal(run(f.repo, 'verify').ok, true);
  const m = mf(r), report = JSON.parse(fs.readFileSync(path.join(r.context, 'files', m.files[0].id, 'refinement.json')));
  assert.equal(report.hunks[0].rule, 'disjoint-token-edits');
});
test('REAL merge: partial hunk resolution keeps original stage-1/2/3 and BASE markers', () => {
  const f = separated(), before = unmerged(f.repo); const r = run(f.repo);
  assert.equal(r.results[0].status, 'partial'); assert.equal(r.results[0].resolvedHunks, 1);
  assert.equal(r.results[0].remainingHunks, 1); assert.equal(unmerged(f.repo), before);
  assert.ok(f.working().startsWith(combined)); assert.match(f.working(), /\|\|\|\|\|\|\| BASE/);
  assert.equal(run(f.repo, 'verify').ok, false);
});
test('partial auto result is idempotent, and later human edits are never replayed over', () => {
  const f = separated(); const r = run(f.repo), first = f.working();
  assert.equal(run(f.repo).results[0].status, 'partial'); assert.equal(f.working(), first);
  f.write(first.replace('mode = "ours"', 'mode = "human-progress"'));
  const edited = f.working(); assert.match(run(f.repo).results[0].reason, /changed since/);
  assert.equal(f.working(), edited); assert.equal(mf(r).files[0].auto, 'partial');
});
test('dry-run writes candidates and reports but never working files or index', () => {
  const f = separated(), before = f.working(), ix = unmerged(f.repo);
  const r = run(f.repo, 'run', '--dry-run'); assert.equal(r.results[0].status, 'would-partially-resolve');
  assert.equal(f.working(), before); assert.equal(unmerged(f.repo), ix);
  assert.ok(fs.readFileSync(r.results[0].candidate, 'utf8').startsWith(combined));
  assert.equal(run(f.repo).results[0].status, 'partial');
});
test('native-only is a real baseline: the same fixture remains unresolved without token refinement', () => {
  const f = fixture(), before = f.working();
  const r = run(f.repo, 'run', '--native-only'); assert.equal(r.results[0].status, 'remaining');
  assert.equal(f.working(), before); assert.ok(unmerged(f.repo));
  assert.equal(run(f.repo).remaining.length, 0);
});
test('pre-existing manual edits prevent new simple-hunk writes', () => {
  const f = fixture(); f.write(f.working() + '// human progress\n');
  const before = f.working(); assert.match(run(f.repo).results[0].reason, /preserve/);
  assert.equal(f.working(), before);
});
test('unrelated staged work remains staged and unmodified', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.repo, 'unrelated.txt'), 'keep\n');
  g(f.repo, ['add', 'unrelated.txt']); run(f.repo);
  assert.equal(g(f.repo, ['show', ':0:unrelated.txt']).stdout, 'keep\n');
});
test('CRLF simple merge retains CRLF on disk and LF in the index', () => {
  const f = fixture(); g(f.repo, ['config', 'core.autocrlf', 'true']); f.write(f.working().replace(/\n/g, '\r\n'));
  assert.equal(run(f.repo).results[0].status, 'resolved');
  assert.equal(f.working(), combined.replace(/\n/g, '\r\n'));
  assert.equal(g(f.repo, ['show', `:0:${f.file}`]).stdout, combined);
  assert.equal(run(f.repo, 'verify').ok, true);
});
test('REAL rebase conflict uses the same refinement with correct side metadata', () => {
  const f = fixture({ op: 'rebase' }), r = run(f.repo);
  assert.equal(f.working(), combined); assert.equal(r.remaining.length, 0);
  assert.equal(mf(r).operation.kind, 'rebase'); assert.equal(run(f.repo, 'verify').ok, true);
});
test('REAL cherry-pick conflict is refined, without continuing or committing', () => {
  const f = fixture({ op: 'cherry-pick' }), head = g(f.repo, ['rev-parse', 'HEAD']).stdout;
  const r = run(f.repo); assert.equal(f.working(), combined);
  assert.equal(g(f.repo, ['rev-parse', 'HEAD']).stdout, head); assert.equal(mf(r).operation.kind, 'cherry-pick');
});
test('known lockfiles are not sent through generic fine-grained merging', () => {
  const f = fixture({ file: 'pnpm-lock.yaml' }), before = f.working();
  assert.match(run(f.repo).results[0].reason, /lockfile/); assert.equal(f.working(), before);
});
test('snapshot tampering is rejected before applying simple changes', () => {
  const f = fixture(), r = run(f.repo, 'prepare'), m = mf(r), before = f.working();
  fs.writeFileSync(path.join(r.context, 'files', m.files[0].id, '2.blob'), 'tampered\n');
  assert.throws(() => run(f.repo, 'auto'), /Snapshot blob changed/); assert.equal(f.working(), before);
});
test('REAL native conflict without a final newline preserves absent final newline', () => {
  const f = fixture({ a: ours.trimEnd(), b: base.trimEnd(), c: theirs.trimEnd() });
  assert.equal(run(f.repo).results[0].status, 'resolved'); assert.equal(f.working(), combined.trimEnd());
});
test('true same-token conflict is unchanged, not selected or combined', () => {
  const f = fixture({ b: 'n = 100;\n', a: 'n = 120;\n', c: 'n = 103;\n' }), before = f.working();
  assert.equal(run(f.repo).results[0].status, 'remaining'); assert.equal(f.working(), before);
});
test('verify catches default whole-side acceptance; a hash-bound reason is required', () => {
  const f = fixture({ b: 'n = 100;\n', a: 'n = 120;\n', c: 'n = 103;\n' }); run(f.repo);
  f.write('n = 120;\n'); g(f.repo, ['add', '--', f.file]);
  let v = run(f.repo, 'verify'); assert.equal(v.ok, false); assert.match(v.errors.join('\n'), /whole-side/);
  const note = path.join(temp, 'review.json');
  fs.writeFileSync(note, JSON.stringify({ oursIntent: 'raise limit to 120', theirsIntent: 'raise limit to 103',
    resolution: '120 intentionally supersedes the lower limit', checks: ['No project checks exist in this fixture'],
    supersedes: 'The larger limit meets the explicitly chosen final requirement.' }));
  run(f.repo, 'review', '--path', f.file, '--note', note);
  assert.equal(run(f.repo, 'verify').ok, true);
  f.write('n = 103;\n'); g(f.repo, ['add', '--', f.file]);
  v = run(f.repo, 'verify'); assert.equal(v.ok, false); assert.match(v.warnings.join('\n'), /stale/);
});
test('review notes cannot omit either intent or actual verification disclosure', () => {
  const f = fixture({ b: 'n = 100;\n', a: 'n = 120;\n', c: 'n = 103;\n' }); run(f.repo);
  f.write('n = 120;\n'); g(f.repo, ['add', '--', f.file]);
  const note = path.join(temp, 'bad-review.json'); fs.writeFileSync(note, '{}');
  assert.throws(() => run(f.repo, 'review', '--path', f.file, '--note', note), /oursIntent/);
});
