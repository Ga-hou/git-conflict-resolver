#!/usr/bin/env node
/** Node >=22; Git >=2.38. No shell, package install, AI API calls, or automatic pushes. Vendored MIT diff primitive. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { markerSize, refineNative } from './simple-merge.mjs';

const MAX = 32 * 1024 * 1024;
const TEXT_MAX = 8 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const mkdir = p => fs.mkdirSync(p, { recursive: true, mode: 0o700 });
function write(p, data) { mkdir(path.dirname(p)); fs.writeFileSync(p, data, { mode: 0o600 }); }
function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function fail(message) { throw new Error(message); }

export function git(repo, args, options = {}) {
  // Reject an inherited alternate index/repository: all commands must target --repo.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_LITERAL_PATHSPECS: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX']) delete env[key];
  const r = spawnSync('git', ['-C', repo, ...args], {
    env, shell: false, windowsHide: true, encoding: null,
    maxBuffer: MAX, timeout: options.timeout ?? 120_000, input: options.input,
  });
  if (r.error) fail(`Git could not run: ${r.error.message}`);
  if (r.signal) fail(`Git interrupted: ${r.signal}`);
  if (!options.allowFailure && r.status !== 0) {
    fail(`git ${args[0]} failed (${r.status}): ${r.stderr.toString('utf8').trim()}`);
  }
  return r;
}
const text = (repo, args) => git(repo, args).stdout.toString('utf8').trim();
function ref(repo, name) {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', name], { allowFailure: true });
  return r.status === 0 ? r.stdout.toString('utf8').trim() : null;
}
function gitDir(repo) { return text(repo, ['rev-parse', '--absolute-git-dir']); }
function root(repo) { return fs.realpathSync(text(path.resolve(repo), ['rev-parse', '--show-toplevel'])); }
function samePath(a, b) {
  const normalize = p => process.platform === 'win32' ? p.toLowerCase() : p;
  return normalize(fs.realpathSync(a)) === normalize(fs.realpathSync(b));
}
function safePath(repo, name) {
  // Git uses slash-separated paths on all platforms. Refuse symlink traversal and .git.
  if (!name || name.includes('\0') || name.includes('\\') || path.isAbsolute(name) ||
      name.split('/').some(c => !c || c === '..' || c === '.' || c.toLowerCase() === '.git')) {
    fail(`Unsupported or unsafe repository path: ${JSON.stringify(name)}`);
  }
  const absolute = path.resolve(repo, name);
  if (!absolute.startsWith(repo + path.sep)) fail('Path escapes repository');
  let current = repo;
  for (const component of name.split('/')) {
    current = path.join(current, component);
    try { if (fs.lstatSync(current).isSymbolicLink()) fail(`Symlink path requires manual handling: ${name}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return absolute;
}
export function parseIndex(bytes) {
  const files = new Map();
  for (const record of utf8.decode(bytes).split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])$/.exec(record.slice(0, tab));
    if (!match) fail('Unexpected index format');
    const name = record.slice(tab + 1);
    if (!files.has(name)) files.set(name, { path: name, stages: {} });
    files.get(name).stages[match[3]] = { mode: match[1], oid: match[2] };
  }
  return [...files.values()];
}
const unmerged = repo => parseIndex(git(repo, ['ls-files', '-u', '-z']).stdout);
const indexed = (repo, name) => parseIndex(git(repo, ['ls-files', '-s', '-z', '--', name]).stdout)[0];
const blob = (repo, oid) => git(repo, ['cat-file', 'blob', oid]).stdout;
function operation(repo) {
  const gd = gitDir(repo);
  const rebase = fs.existsSync(path.join(gd, 'rebase-merge')) || fs.existsSync(path.join(gd, 'rebase-apply'));
  const head = ref(repo, 'HEAD');
  const mergeFile = path.join(gd, 'MERGE_HEAD');
  const mergeHeads = fs.existsSync(mergeFile) ? fs.readFileSync(mergeFile, 'utf8').trim().split(/\s+/) : [];
  const replay = ref(repo, 'REBASE_HEAD') || ref(repo, 'CHERRY_PICK_HEAD');
  const revert = ref(repo, 'REVERT_HEAD');
  const kind = rebase ? 'rebase' : mergeHeads.length ? 'merge' : replay ? 'cherry-pick' : revert ? 'revert' : 'index';
  const other = mergeHeads.length === 1 ? mergeHeads[0] : replay;
  const bases = other ? git(repo, ['merge-base', '--all', head, other], { allowFailure: true }).stdout.toString().trim().split(/\s+/).filter(Boolean) : [];
  const parentLine = replay ? text(repo, ['rev-list', '--parents', '-n', '1', replay]).split(' ') : [];
  return {
    kind, head, other, mergeHeads, replay, revert, mergeBases: bases,
    replayParents: parentLine.slice(1),
    roles: rebase ? { ours: 'already-rebased history / upstream plus replayed commits', theirs: 'commit currently being replayed' }
      : { ours: 'index stage 2 (not necessarily the user\'s original branch)', theirs: 'index stage 3' },
    supportedAuto: ['merge', 'rebase', 'cherry-pick', 'index'].includes(kind) && mergeHeads.length <= 1,
  };
}
function identity(op) {
  return sha(JSON.stringify([op.kind, op.head, op.other, op.mergeHeads, op.replay, op.revert]));
}
function attributes(repo, name) {
  const names = ['merge', 'filter', 'working-tree-encoding', 'ident', 'text', 'eol', 'conflict-marker-size'];
  const fields = git(repo, ['check-attr', '-z', ...names, '--', name]).stdout.toString('utf8').split('\0');
  const result = {};
  for (let i = 0; i + 2 < fields.length; i += 3) result[fields[i + 1]] = fields[i + 2];
  return result;
}
function ordinaryAttributes(a) {
  return ['unspecified', 'set', 'text'].includes(a.merge) &&
    ['unspecified', 'unset'].includes(a.filter) &&
    ['unspecified', 'unset'].includes(a['working-tree-encoding']) &&
    ['unspecified', 'unset'].includes(a.ident) && a.text !== 'unset';
}
function isText(data) {
  if (data.length > TEXT_MAX || data.includes(0)) return false;
  try { utf8.decode(data); return true; } catch { return false; }
}
function working(repo, name) {
  const absolute = safePath(repo, name);
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.size > TEXT_MAX) return null;
    const bytes = fs.readFileSync(absolute);
    return { absolute, bytes, hash: sha(bytes), mode: stat.mode };
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function cleanMode(stages) {
  const b = stages['1']?.mode, o = stages['2']?.mode, t = stages['3']?.mode;
  return o === t ? o : o === b ? t : t === b ? o : null;
}
function checkStages(repo, entry) {
  const current = indexed(repo, entry.path);
  if (JSON.stringify(current?.stages) !== JSON.stringify(entry.stages)) fail(`Index changed: ${entry.path}; prepare a new session after review`);
}
function stateRoot(repo) { return path.join(gitDir(repo), 'agent-conflict-resolver'); }
function load(repo) {
  const active = path.join(stateRoot(repo), 'active.json');
  if (!fs.existsSync(active)) fail('No conflict session. Run prepare or run first.');
  const id = readJSON(active).id;
  if (!/^[a-f0-9-]{36}$/.test(id)) fail('Invalid session id');
  const dir = path.join(stateRoot(repo), 'sessions', id);
  const manifest = readJSON(path.join(dir, 'manifest.json'));
  if (manifest.identity !== identity(operation(repo))) fail('Git operation changed; run prepare for this merge/rebase step');
  return { dir, manifest };
}
function save(session) { write(path.join(session.dir, 'manifest.json'), json(session.manifest)); }
function fileContext(repo, dir, entry, op) {
  const folder = path.join(dir, 'files', entry.id);
  mkdir(folder);
  // Full messages and patches are local data, never shell instructions.
  for (const [stage, version] of Object.entries(entry.stages)) {
    write(path.join(folder, `${stage}.json`), json(version));
    if (version.mode !== '160000') write(path.join(folder, `${stage}.blob`), blob(repo, version.oid));
  }
  for (const side of ['2', '3']) {
    if (entry.stages['1'] && entry.stages[side] && entry.type !== 'submodule') {
      const r = git(repo, ['diff', '--no-ext-diff', '--no-textconv', entry.stages['1'].oid, entry.stages[side].oid], { allowFailure: true });
      write(path.join(folder, `${side}.diff`), r.stdout);
    }
  }
  const refs = {
    ours: op.other ? `${op.other}..${op.head}` : op.head,
    theirs: op.other ? `${op.head}..${op.other}` : null,
  };
  if (['rebase', 'cherry-pick'].includes(op.kind) && op.replay) refs.theirs = `${op.replay}^!`;
  for (const [side, range] of Object.entries(refs)) {
    if (!range) continue;
    const r = git(repo, ['log', '--max-count=40', '--format=commit %H%nparents %P%n%B', '-p', '--no-ext-diff', '--no-textconv', range, '--', entry.path], { allowFailure: true });
    write(path.join(folder, `${side}.commits.patch`), r.stdout);
  }
}
export function prepare(repo, options = {}) {
  const op = operation(repo), entries = unmerged(repo), base = stateRoot(repo);
  if (!options.new && fs.existsSync(path.join(base, 'active.json'))) {
    try {
      const previous = load(repo);
      const known = new Map(previous.manifest.files.map(e => [e.path, e]));
      for (const entry of entries) {
        if (!known.has(entry.path) || JSON.stringify(known.get(entry.path).stages) !== JSON.stringify(entry.stages)) {
          fail('Conflict index changed within this operation; review it, then use prepare --new');
        }
      }
      return previous;
    } catch (e) {
      if (!e.message.startsWith('Git operation changed;')) throw e;
    }
  }
  const id = crypto.randomUUID(), dir = path.join(base, 'sessions', id);
  const manifest = { version: 2, id, repository: repo, created: new Date().toISOString(), operation: op,
    identity: identity(op), historyLimit: 40, historyWarning: 'Logs are bounded hints; inspect more history and rename paths when needed. Stage 1 is the authoritative file merge base.', files: [] };
  mkdir(dir);
  write(path.join(dir, 'initial-index.txt'), git(repo, ['ls-files', '-s', '-z']).stdout);
  write(path.join(dir, 'initial-status.txt'), git(repo, ['status', '--porcelain=v1', '-z']).stdout);
  for (const e of entries) {
    const modes = Object.values(e.stages).map(s => s.mode);
    const entry = { ...e, id: sha(e.path).slice(0, 24), type: modes.every(m => m === '160000') ? 'submodule' : 'manual', auto: 'pending' };
    const regular = modes.every(m => ['100644', '100755'].includes(m));
    if (regular && e.stages['1'] && e.stages['2'] && e.stages['3']) entry.type = 'text';
    fileContext(repo, dir, entry, op);
    if (entry.type !== 'submodule') {
      try {
        const w = working(repo, e.path);
        entry.attributes = attributes(repo, e.path);
        if (w) {
          entry.worktreeHash = w.hash;
          write(path.join(dir, 'files', entry.id, 'worktree.before'), w.bytes);
          if (entry.type === 'text' && ordinaryAttributes(entry.attributes)) {
            // AUTO_MERGE is Git's original result: do not replace pre-existing manual edits.
            const auto = git(repo, ['ls-tree', '-z', 'AUTO_MERGE', '--', e.path], { allowFailure: true });
            const m = /^\d{6} blob ([a-f0-9]{40}|[a-f0-9]{64})\t/.exec(auto.stdout.toString('utf8'));
            const normalized = git(repo, ['hash-object', `--path=${e.path}`, '--stdin'], { input: w.bytes });
            entry.pristine = !!m && m[1] === normalized.stdout.toString('utf8').trim();
          }
        }
      } catch (e) { entry.type = 'manual'; entry.note = e.message; }
    }
    manifest.files.push(entry);
  }
  const session = { dir, manifest };
  save(session);
  write(path.join(base, 'active.json'), json({ id }));
  return session;
}
function stage(repo, name, mode, oid) {
  // An exact NUL-delimited index update, never a glob or whole-repository `git add`.
  const zero = '0'.repeat(oid.length);
  git(repo, ['update-index', '-z', '--index-info'], {
    input: Buffer.from(`0 ${zero}\t${name}\0${mode} ${oid} 0\t${name}\0`),
  });
}
const GENERATED = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'bun.lock', 'bun.lockb', 'cargo.lock', 'gemfile.lock', 'composer.lock', 'poetry.lock', 'uv.lock', 'go.sum']);
function generatedPath(name) { return GENERATED.has(path.basename(name).toLowerCase()) || /\.min\.(?:js|css)$|\.map$/i.test(name); }
function worktreeOutput(canonical, original) {
  // Canonical blob bytes are not changed. Preserve a consistently CRLF worktree.
  if (original.includes(Buffer.from('\r\n')) && !/(?<!\r)\n/.test(original.toString('utf8'))) {
    return Buffer.from(canonical.toString('utf8').replace(/(?<!\r)\n/g, '\r\n'));
  }
  return canonical;
}
export function autoResolve(repo, session, options = {}) {
  const result = [];
  const pending = new Set(unmerged(repo).map(e => e.path));
  for (const entry of session.manifest.files) {
    if (!pending.has(entry.path)) continue;
    let reason;
    if (!session.manifest.operation.supportedAuto) reason = 'unsupported operation; manual review';
    else if (entry.type !== 'text') reason = `${entry.type}: needs dedicated resolution`;
    else if (!entry.pristine) reason = 'no pristine AUTO_MERGE proof; preserve existing work';
    else if (!ordinaryAttributes(attributes(repo, entry.path))) reason = 'custom merge/filter/encoding/attributes';
    if (reason) { result.push({ path: entry.path, status: 'remaining', reason }); continue; }
    checkStages(repo, entry);
    const w = working(repo, entry.path);
    if (entry.auto === 'partial' && w?.hash === entry.lastAutoHash) {
      result.push({ path: entry.path, status: 'partial', reason: 'previous simple-hunk result retained; Agent handles the rest',
        resolvedHunks: entry.refinement.resolved, remainingHunks: entry.refinement.remaining }); continue;
    }
    if (!w || w.hash !== entry.worktreeHash) {
      result.push({ path: entry.path, status: 'remaining', reason: 'working file changed since prepare' }); continue;
    }
    // Do not replay an interrupted write journal. Inspect the saved original/candidate.
    if (entry.auto.startsWith('writing')) {
      result.push({ path: entry.path, status: 'remaining', reason: 'interrupted write; inspect journal and backups' }); continue;
    }
    const folder = path.join(session.dir, 'files', entry.id);
    const inputs = ['2', '1', '3'].map(stage => path.join(folder, `${stage}.blob`));
    const contents = inputs.map(p => fs.readFileSync(p));
    if (!contents.every(isText) || !cleanMode(entry.stages)) {
      result.push({ path: entry.path, status: 'remaining', reason: 'binary/large text or ambiguous mode' }); continue;
    }
    for (let i = 0; i < contents.length; i++) {
      const oid = git(repo, ['hash-object', '--stdin'], { input: contents[i] }).stdout.toString().trim();
      if (oid !== entry.stages[['2', '1', '3'][i]].oid) fail(`Snapshot blob changed: ${entry.path}; original index was preserved`);
    }
    const originals = contents.map(b => b.toString('utf8'));
    const size = markerSize(originals);
    if (size > 128) { result.push({ path: entry.path, status: 'remaining', reason: 'marker-size budget exceeded' }); continue; }
    const merged = git(repo, ['merge-file', '-p', '--diff3', `--marker-size=${size}`,
      '-L', 'OURS', '-L', 'BASE', '-L', 'THEIRS', ...inputs], { allowFailure: true });
    if (merged.status > 127) fail(`merge-file failed for ${entry.path}: ${merged.stderr}`);
    write(path.join(folder, 'candidate.native.diff3'), merged.stdout);
    let canonical = merged.stdout;
    let complete = merged.status === 0;
    let refinement = null;
    if (!complete) {
      write(path.join(folder, 'candidate.diff3'), merged.stdout);
      if (options['native-only'] || generatedPath(entry.path)) {
        result.push({ path: entry.path, status: 'remaining', reason: generatedPath(entry.path)
          ? 'generated/lockfile: reconcile source and use the project generator' : 'native-only: overlapping changes' }); continue;
      }
      refinement = refineNative(merged.stdout.toString('utf8'), originals, size);
      // Saturating Git exit codes (127) are supported; unexpected parse results
      // are not accepted as evidence that a conflicted candidate became clean.
      if (refinement.valid && Math.min(refinement.hunks.length, 127) !== merged.status) {
        refinement = { ...refinement, valid: false, reason: 'native-hunk-count-mismatch' };
      }
      entry.refinement = { ...refinement, text: undefined, engine: 'lossless-token-v2', markerSize: size };
      write(path.join(folder, 'refinement.json'), json(entry.refinement));
      save(session);
      if (!refinement.valid || !refinement.resolved) {
        result.push({ path: entry.path, status: 'remaining', reason: refinement.reason || 'overlapping changes; read commit intent',
          resolvedHunks: 0, remainingHunks: refinement.remaining ?? null }); continue;
      }
      canonical = Buffer.from(refinement.text);
      complete = refinement.remaining === 0;
      write(path.join(folder, 'candidate.diff3'), canonical);
    }
    const output = worktreeOutput(canonical, w.bytes);
    if (options['dry-run']) {
      write(path.join(folder, 'candidate.worktree'), output);
      result.push({ path: entry.path, status: complete ? 'would-resolve' : 'would-partially-resolve',
        candidate: path.join(folder, 'candidate.worktree'), resolvedHunks: refinement?.resolved ?? 0,
        remainingHunks: refinement?.remaining ?? 0, staged: false }); continue;
    }
    checkStages(repo, entry);
    if (working(repo, entry.path)?.hash !== w.hash) fail(`Concurrent edit detected: ${entry.path}`);
    if (!complete) {
      // Crucial difference from v1: apply simple HUNKS but keep every original
      // stage-1/2/3 entry while any hunk in this file remains unresolved.
      entry.auto = 'writing-partial'; entry.lastAutoHash = sha(output); save(session);
      fs.writeFileSync(w.absolute, output);
      entry.auto = 'partial'; save(session);
      result.push({ path: entry.path, status: 'partial', resolvedHunks: refinement.resolved,
        remainingHunks: refinement.remaining, staged: false, reason: 'simple hunks applied; index remains unmerged' }); continue;
    }
    const mode = cleanMode(entry.stages);
    const object = git(repo, ['hash-object', '-w', '--stdin'], { input: canonical }).stdout.toString('utf8').trim();
    entry.auto = 'writing'; entry.result = { oid: object, mode }; save(session);
    fs.writeFileSync(w.absolute, output);
    if (process.platform !== 'win32') fs.chmodSync(w.absolute, mode === '100755' ? w.mode | 0o111 : w.mode & ~0o111);
    stage(repo, entry.path, mode, object);
    entry.auto = 'resolved'; save(session);
    result.push({ path: entry.path, status: 'resolved', oid: object, staged: true,
      resolvedHunks: refinement?.resolved ?? 0, remainingHunks: 0,
      reason: refinement ? 'simple token hunks resolved without selecting a side' : 'clean native three-way merge' });
  }
  const remaining = unmerged(repo).map(e => e.path);
  return { context: session.dir, results: result, remaining, dryRun: !!options['dry-run'], semanticsVerified: false,
    summary: { resolvedFiles: result.filter(r => r.status === 'resolved').length,
      partiallyResolvedFiles: result.filter(r => r.status === 'partial').length,
      remainingFiles: remaining.length,
      simpleHunksResolved: result.reduce((n, r) => n + (r.resolvedHunks || 0), 0),
      note: 'Hunk counts cover inspected simple-merge candidates, not binary/skipped/submodule conflicts.' } };
}
function subRepo(repo, name) {
  const absolute = safePath(repo, name);
  if (!fs.existsSync(path.join(absolute, '.git'))) fail(`Submodule not initialized: ${name}. Use submodule-prepare --path ... --init --url <trusted-url>`);
  if (!samePath(root(absolute), absolute)) fail('Submodule path resolved to the parent repository');
  return absolute;
}
function ancestor(repo, a, b) {
  const r = git(repo, ['merge-base', '--is-ancestor', a, b], { allowFailure: true });
  if (r.status > 1) fail(`Cannot determine ancestry for ${a} and ${b}`);
  return r.status === 0;
}
function completeHistory(repo, commits) {
  for (const commit of commits) if (!ref(repo, `${commit}^{commit}`)) fail(`Missing submodule commit ${commit}; fetch the required objects first`);
  if (text(repo, ['rev-parse', '--is-shallow-repository']) === 'true') fail('Shallow submodule: explicitly deepen/unshallow before ancestry decisions');
}
function protectNewPaths(repo, current, targets) {
  // Ignored files do not appear in ordinary status. Protect files that incoming
  // trees would newly track, including when a merge conflicts elsewhere first.
  const names = new Set();
  for (const target of targets) {
    const added = git(repo, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', current, target]).stdout;
    for (const name of utf8.decode(added).split('\0').filter(Boolean)) names.add(name);
  }
  for (const name of names) {
    const absolute = safePath(repo, name);
    if (fs.existsSync(absolute)) fail(`Would overwrite an ignored/untracked local path: ${name}; preserve it before preparing the submodule`);
  }
}
function requireClean(repo) {
  if (git(repo, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.length) fail('Submodule has local changes or untracked files; preserve/commit them before proceeding');
  if (operation(repo).kind !== 'index') fail('Submodule already has an operation in progress');
}
function entryFor(session, name) {
  const entry = session.manifest.files.find(e => e.path === name);
  if (!entry || entry.type !== 'submodule' || !entry.stages['2'] || !entry.stages['3']) {
    fail('Expected a recorded gitlink conflict with both sides; add/delete/type conflicts require manual resolution');
  }
  return entry;
}
export function prepareSubmodule(repo, session, options) {
  const entry = entryFor(session, options.path);
  checkStages(repo, entry);
  const location = safePath(repo, entry.path);
  if (options.init && !fs.existsSync(path.join(location, '.git'))) {
    if (!options.url || options.url.startsWith('-')) fail('--init requires an explicit trusted --url; never guess a submodule remote');
    if (fs.existsSync(location) && fs.readdirSync(location).length) fail('Refusing to clone over a nonempty directory');
    // This intentionally creates an old-form embedded Git directory. Absorption is optional later.
    git(repo, ['clone', '--no-checkout', '--', options.url, location]);
    const initial = entry.stages['2'].oid;
    if (!ref(location, `${initial}^{commit}`)) fail('Clone does not contain OURS; fetch its commit explicitly');
    git(location, ['switch', '--detach', '--no-recurse-submodules', '--no-overwrite-ignore', initial]);
  }
  const child = subRepo(repo, entry.path);
  if (options.fetch) {
    const remote = options.remote || 'origin';
    if (!text(child, ['remote']).split(/\r?\n/).includes(remote)) fail('Fetch remote must name an existing configured remote');
    git(child, ['fetch', '--no-recurse-submodules', '--', remote]);
  }
  const ours = entry.stages['2'].oid, theirs = entry.stages['3'].oid;
  completeHistory(child, [ours, theirs]);
  const current = ref(child, 'HEAD');
  const active = entry.submodule;
  if (active?.branch && text(child, ['branch', '--show-current']) === active.branch) {
    const status = operation(child).kind !== 'index' ? 'needs-agent-or-commit'
      : ancestor(child, ours, current) && ancestor(child, theirs, current) ? 'ready-to-review' : 'merge-aborted-or-incomplete';
    return { path: entry.path, repository: child, status, branch: active.branch, head: current, remaining: unmerged(child).map(e => e.path) };
  }
  requireClean(child);
  const start = ancestor(child, ours, current) ? current : ours;
  let candidate = null;
  if (ancestor(child, theirs, start)) candidate = start;
  else if (ancestor(child, start, theirs)) candidate = theirs;
  if (!candidate && !git(child, ['merge-base', start, theirs], { allowFailure: true }).stdout.length) fail('Unrelated submodule histories; do not automatically merge');
  protectNewPaths(child, current, [candidate || start, theirs]);
  if (!candidate && git(child, ['var', 'GIT_COMMITTER_IDENT'], { allowFailure: true }).status !== 0) {
    fail(`Configure your Git user.name and user.email in ${child} before preparing its merge; no identity is invented`);
  }
  const suffix = `${session.manifest.id.slice(0, 8)}-${entry.id.slice(0, 8)}`;
  const backup = `conflict-backup/${suffix}`, branch = `conflict-resolve/${suffix}`;
  git(child, ['branch', backup, current]);
  entry.submodule = { originalHead: current, start, ours, theirs, branch, backup, candidate, status: 'prepared' };
  save(session); // Journal before switching; original HEAD remains named even on an error.
  git(child, ['switch', '--no-recurse-submodules', '--no-overwrite-ignore', '-c', branch, candidate || start]);
  if (!candidate) {
    const merged = git(child, ['-c', 'rerere.enabled=false', '-c', 'rerere.autoupdate=false', 'merge', '--no-ff', '--no-commit', '--no-overwrite-ignore', theirs], { allowFailure: true });
    if (merged.status !== 0 && !unmerged(child).length) fail(`Submodule merge failed: ${merged.stderr.toString('utf8')}`);
    entry.submodule.status = 'needs-agent-or-commit';
  } else entry.submodule.status = 'ready-to-review';
  save(session);
  return { path: entry.path, repository: child, ...entry.submodule, remaining: unmerged(child).map(e => e.path), parentStillUnmerged: true };
}
export function pinSubmodule(repo, session, options) {
  const entry = entryFor(session, options.path), child = subRepo(repo, entry.path);
  if (!options.reviewed) fail('Review both histories and run relevant tests, then pass --reviewed');
  const oid = ref(child, 'HEAD');
  completeHistory(child, [entry.stages['2'].oid, entry.stages['3'].oid, oid]);
  requireClean(child);
  for (const s of ['2', '3']) if (!ancestor(child, entry.stages[s].oid, oid)) fail(`Refusing pin: HEAD does not include stage ${s}`);
  const existing = indexed(repo, entry.path);
  if (!(existing?.stages['0']?.oid === oid && existing.stages['0'].mode === '160000')) checkStages(repo, entry);
  stage(repo, entry.path, '160000', oid);
  entry.pinned = oid; save(session);
  return { path: entry.path, pinned: oid, includesBothHistories: true, published: false,
    reminder: 'Local pin only. Push/verify child reachability before publishing the parent.' };
}
function markers(bytes) {
  if (!isText(bytes)) return false;
  // Require a complete ordered marker block, not an isolated Markdown separator.
  return /^(<{7,})[^\r\n]*\r?\n[\s\S]*?^={7,}\r?\n[\s\S]*?^>{7,}[^\r\n]*(?:\r?\n|$)/m.test(bytes.toString('utf8'));
}
function wholeSideChoice(entry, indexedStage) {
  const b = entry.stages['1'], o = entry.stages['2'], t = entry.stages['3'];
  return entry.type === 'text' && b && o && t && o.oid !== t.oid && o.oid !== b.oid && t.oid !== b.oid &&
    (indexedStage?.oid === o.oid || indexedStage?.oid === t.oid);
}
export function recordReview(repo, session, options) {
  const entry = session.manifest.files.find(e => e.path === options.path);
  if (!entry || entry.type === 'submodule') fail('Review requires an exact original regular-file conflict path');
  const i = indexed(repo, entry.path)?.stages['0'];
  if (!i) fail('Stage the reviewed final result for this exact path first');
  if (!options.note) fail('--note must name a local JSON review file; it is read as data, never executed');
  const filename = path.resolve(options.note);
  if (fs.statSync(filename).size > 64 * 1024) fail('Review note is too large');
  const note = readJSON(filename);
  for (const key of ['oursIntent', 'theirsIntent', 'resolution']) {
    if (typeof note[key] !== 'string' || !note[key].trim()) fail(`Review requires nonempty ${key}`);
  }
  if (!Array.isArray(note.checks) || !note.checks.length || note.checks.some(c => typeof c !== 'string' || !c.trim())) {
    fail('Review checks must list actual evidence, or explicitly state that checks were not run and why');
  }
  if (wholeSideChoice(entry, i) && (typeof note.supersedes !== 'string' || !note.supersedes.trim())) {
    fail('Whole-side choice requires supersedes: explain why the other side is retained or deliberately superseded');
  }
  entry.review = { oid: i.oid, mode: i.mode, recorded: new Date().toISOString(), ...{
    oursIntent: note.oursIntent, theirsIntent: note.theirsIntent, resolution: note.resolution,
    checks: note.checks, supersedes: note.supersedes,
  } };
  write(path.join(session.dir, 'files', entry.id, 'review.json'), json(entry.review));
  save(session);
  return { path: entry.path, reviewedOid: i.oid, recorded: true, semanticsVerified: false };
}
export function verify(repo, session) {
  const errors = [], warnings = [];
  const pending = unmerged(repo);
  if (pending.length) errors.push(`Unmerged index entries: ${pending.map(e => e.path).join(', ')}`);
  for (const cached of [false, true]) {
    const r = git(repo, ['diff', ...(cached ? ['--cached'] : []), '--check'], { allowFailure: true });
    if (r.status !== 0) errors.push(`${cached ? 'Index' : 'Worktree'} diff --check: ${r.stdout.toString().trim() || r.stderr.toString().trim()}`);
  }
  for (const entry of session.manifest.files) {
    const i = indexed(repo, entry.path)?.stages['0'];
    if (wholeSideChoice(entry, i) && !(entry.review?.oid === i.oid && entry.review?.mode === i.mode && entry.review?.supersedes)) {
      errors.push(`${entry.path}: whole-side result while BOTH original sides changed; record a hash-bound review with supersedes, not default accept ours/theirs`);
    }
    if (entry.review && i && (entry.review.oid !== i.oid || entry.review.mode !== i.mode)) warnings.push(`${entry.path}: review is stale; staged result changed`);
    if (entry.type === 'submodule' && entry.stages['2'] && entry.stages['3']) {
      try {
        if (!i || i.mode !== '160000') fail('not a staged gitlink');
        const child = subRepo(repo, entry.path);
        completeHistory(child, [entry.stages['2'].oid, entry.stages['3'].oid, i.oid]);
        if (i.oid !== ref(child, 'HEAD')) fail('staged gitlink differs from checked-out HEAD');
        requireClean(child);
        for (const s of ['2', '3']) if (!ancestor(child, entry.stages[s].oid, i.oid)) fail(`pin discards stage ${s} history`);
        warnings.push(`${entry.path}: remote reachability is not verified; publish submodule before parent`);
      } catch (e) { errors.push(`${entry.path}: ${e.message}`); }
    } else {
      try {
        const w = working(repo, entry.path);
        if (w && markers(w.bytes)) errors.push(`${entry.path}: conflict markers remain in working file`);
        if (i && ['100644', '100755'].includes(i.mode) && markers(blob(repo, i.oid))) errors.push(`${entry.path}: conflict markers remain in staged blob`);
        if (i && git(repo, ['diff', '--quiet', '--', entry.path], { allowFailure: true }).status !== 0) errors.push(`${entry.path}: resolved worktree differs from staged result`);
      } catch (e) { warnings.push(`${entry.path}: ${e.message}; inspect manually`); }
    }
  }
  return { ok: errors.length === 0, errors, warnings, semanticsVerified: false,
    note: 'Structural checks do not prove both intents are preserved. Review the patch and run project-specific tests before continuing.' };
}
function locked(repo, fn) {
  const dir = stateRoot(repo); mkdir(dir);
  const lock = path.join(dir, 'command.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') fail(`Another resolver may be active. Inspect ${lock}; remove only after confirming no process is using it.`); throw e; }
  fs.writeFileSync(fd, json({ pid: process.pid, started: new Date().toISOString() }));
  try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function argsOf(args) {
  const result = { command: args[0] || 'help', repo: process.cwd() };
  const flags = new Set(['new', 'fetch', 'init', 'reviewed', 'dry-run', 'native-only']);
  const values = new Set(['repo', 'path', 'remote', 'url', 'note']);
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith('--')) fail(`Unexpected argument: ${args[i]}`);
    const key = args[i].slice(2);
    if (flags.has(key)) result[key] = true;
    else if (values.has(key) && args[i + 1] !== undefined) result[key] = args[++i];
    else fail(`Unknown or incomplete option: --${key}`);
  }
  return result;
}
export function main(argv = process.argv.slice(2)) {
  const options = argsOf(argv);
  if (options.command === 'help') return { usage: [
    'node resolve.mjs run --repo PATH [--dry-run] [--native-only]', 'node resolve.mjs prepare --repo PATH [--new]',
    'node resolve.mjs auto --repo PATH [--dry-run] [--native-only]',
    'node resolve.mjs submodule-prepare --repo PATH --path MODULE [--fetch --remote origin] [--init --url TRUSTED_URL]',
    'node resolve.mjs submodule-pin --repo PATH --path MODULE --reviewed',
    'node resolve.mjs review --repo PATH --path FILE --note REVIEW.json',
    'node resolve.mjs verify --repo PATH', 'node resolve.mjs doctor --repo PATH',
  ], exitCodes: { 0: 'command succeeded; inspect remaining conflicts', 1: 'safety refusal or execution error', 2: 'verify found outstanding problems' } };
  const repo = root(options.repo);
  if (options.command === 'doctor') return { repository: repo, gitDir: gitDir(repo), git: text(repo, ['--version']), node: process.version, platform: process.platform, operation: operation(repo), conflicts: unmerged(repo) };
  return locked(repo, () => {
    if (options.command === 'prepare') { const s = prepare(repo, options); return { context: s.dir, manifest: path.join(s.dir, 'manifest.json'), remaining: unmerged(repo).map(e => e.path) }; }
    if (options.command === 'run') return autoResolve(repo, prepare(repo, options), options);
    const session = load(repo);
    if (options.command === 'auto') return autoResolve(repo, session, options);
    if (options.command === 'submodule-prepare') return prepareSubmodule(repo, session, options);
    if (options.command === 'submodule-pin') return pinSubmodule(repo, session, options);
    if (options.command === 'review') return recordReview(repo, session, options);
    if (options.command === 'verify') return verify(repo, session);
    fail(`Unknown command: ${options.command}`);
  });
}
// Resolve symlinked directories and Windows short paths before checking the CLI entrypoint.
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))) {
  try { const result = main(); console.log(json(result)); if (result.ok === false) process.exitCode = 2; }
  catch (e) { console.error(json({ ok: false, error: e.message })); process.exitCode = 1; }
}
