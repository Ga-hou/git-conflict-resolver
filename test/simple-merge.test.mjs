import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSimple, tokenize, refineDiff3, refineNative, markerSize, LIMITS } from '../skills/git-conflict-resolver/scripts/simple-merge.mjs';
import { diffIndices } from '../skills/git-conflict-resolver/scripts/vendor/node-diff3.mjs';

const base = 'const options = { retries: 2, timeout: 1000 };\n';
const ours = base.replace('retries: 2', 'retries: 3');
const theirs = base.replace('timeout: 1000', 'timeout: 2000');
const expected = 'const options = { retries: 3, timeout: 2000 };\n';
const block = (a, o, b, n = 7) => `${'<'.repeat(n)} OURS\n${a}${'|'.repeat(n)} BASE\n${o}${'='.repeat(n)}\n${b}${'>'.repeat(n)} THEIRS\n`;

test('word merge combines independent changes within one Git-conflicted line', () => {
  const r = mergeSimple(ours, base, theirs);
  assert.equal(r.resolved, true); assert.equal(r.text, expected);
  assert.equal(r.rule, 'disjoint-token-edits'); assert.deepEqual(r.edits.map(e => e.side), ['ours', 'theirs']);
});
test('swapping ours and theirs does not change a successful result', () => {
  assert.equal(mergeSimple(theirs, base, ours).text, expected);
});
test('same numeric token is never character-blended', () => {
  assert.equal(mergeSimple('n = 120;\n', 'n = 100;\n', 'n = 103;\n').resolved, false);
});
test('same identifier token is never character-blended', () => {
  assert.equal(mergeSimple('food();\n', 'foo();\n', 'fool();\n').resolved, false);
});
test('quoted strings and templates stay atomic on competing edits', () => {
  for (const quote of ['"', "'", '`']) {
    assert.equal(mergeSimple(`s = ${quote}big cat${quote};\n`, `s = ${quote}cat${quote};\n`, `s = ${quote}cats${quote};\n`).resolved, false);
  }
});
test('competing line-comment edits are not silently concatenated', () => {
  assert.equal(mergeSimple('// big cat\n', '// cat\n', '// cats\n').resolved, false);
});
test('same-position competing insertions and delete/modify stay conflicted', () => {
  assert.equal(mergeSimple('left\n', '', 'right\n').resolved, false);
  assert.equal(mergeSimple('', 'original\n', 'modified\n').resolved, false);
});
test('identity rules preserve additions and deletions with no contradictory edit', () => {
  assert.equal(mergeSimple('x\n', 'a\n', 'x\n').text, 'x\n');
  assert.equal(mergeSimple('a\n', 'a\n', 'x\n').text, 'x\n');
  assert.equal(mergeSimple('x\n', 'a\n', 'a\n').text, 'x\n');
  assert.equal(mergeSimple('', 'a\n', '').text, '');
});
test('whitespace-only disagreements are not ignored', () => {
  assert.equal(mergeSimple('  call();\n', 'call();\n', '\tcall();\n').resolved, false);
});
test('lossless tokenization preserves Unicode, emoji, BOM, tabs and CRLF', () => {
  const s = '\ufeffconst 用户 = "😀\\\"x";\r\n\tconst n = 1.5e-3; /*你好*/\r\n';
  assert.equal(tokenize(s).join(''), s);
  assert.ok(tokenize(s).includes('1.5e-3'));
});
test('unclosed literals and comments are rejected by the tokenizer', () => {
  assert.equal(tokenize('x = "unterminated'), null);
  assert.equal(tokenize('/* unterminated'), null);
});
test('literal Object prototype property names do not corrupt upstream diff lookup', () => {
  const a = ['__proto__', 'constructor', 'toString', '1'];
  const b = ['__proto__', 'constructor', 'toString', '2'];
  assert.deepEqual(diffIndices(a, b)[0].buffer1, [3, 1]);
});
test('ambiguous repeated-token alignment is left for the Agent', () => {
  assert.equal(mergeSimple('a a;\n', 'a a a;\n', 'a a b;\n').resolved, false);
});
test('resource limits refuse large or highly repetitive fine-grained diffs', () => {
  const b = 'z'.repeat(LIMITS.characters + 1);
  assert.equal(mergeSimple('a' + b, b, b + 'b').reason, 'hunk-size-limit');
  const x = 'a '.repeat(500);
  assert.equal(mergeSimple(x + 'left', x, x + 'right').resolved, false);
});
test('partial refinement changes only the simple hunk, retaining the other block verbatim', () => {
  const hard = block('mode = "ours";\n', 'mode = "base";\n', 'mode = "theirs";\n');
  const candidate = 'prefix\n' + block(ours, base, theirs) + 'untouched\n' + hard + 'suffix\n';
  const r = refineDiff3(candidate);
  assert.equal(r.valid, true); assert.equal(r.resolved, 1); assert.equal(r.remaining, 1);
  assert.equal(r.text, 'prefix\n' + expected + 'untouched\n' + hard + 'suffix\n');
});
test('malformed or nested candidate markers never authorize a write', () => {
  const r = refineDiff3(block(ours, base, theirs).replace('||||||| BASE\n', ''));
  assert.equal(r.valid, false);
  assert.equal(refineDiff3(block(block(ours, base, theirs), base, theirs)).valid, false);
});
test('collision-free generated marker size preserves literal marker-like content', () => {
  const n = markerSize(['<<<<<<< literal\n']); assert.equal(n, 8);
  const candidate = '<<<<<<< literal\n' + block(ours, base, theirs, n);
  assert.equal(refineDiff3(candidate, n).text, '<<<<<<< literal\n' + expected);
});
test('single-line files without final newline stay without final newline', () => {
  const inputs = [ours.trimEnd(), base.trimEnd(), theirs.trimEnd()];
  const r = refineNative(block(ours, base, theirs), inputs);
  assert.equal(r.text, expected.trimEnd()); assert.equal(r.remaining, 0);
});
test('unterminated multiline EOF is conservatively left to the Agent', () => {
  assert.equal(refineNative(block(ours, base, theirs), [ours + 'x', base + 'x', theirs + 'x']).valid, false);
});
test('bounded property check: 250 independent field edits retain both sides and are symmetric', () => {
  for (let i = 0; i < 250; i++) {
    const b = `let config = { left: ${10000 + i}, right: ${20000 + i} };\n`;
    const a = b.replace(String(10000 + i), String(30000 + i));
    const c = b.replace(String(20000 + i), String(40000 + i));
    const expected = a.replace(String(20000 + i), String(40000 + i));
    assert.equal(mergeSimple(a, b, c).text, expected);
    assert.equal(mergeSimple(c, b, a).text, expected);
  }
});
