/**
 * Lossless, conservative token-level refinement of native Git diff3 hunks.
 * Algorithm inspiration: JetBrains MergeResolveUtil.SimpleHelper (word merge).
 * LCS/diff primitives: vendored MIT node-diff3. This is NOT an IDEA algorithm port.
 * No whitespace ignoring, character blending, greedy deletion, or union fallback.
 */
import { diffIndices } from './vendor/node-diff3.mjs';

export const LIMITS = Object.freeze({ characters: 64 * 1024, tokens: 2048, matches: 16384, hunks: 256 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const failure = reason => ({ resolved: false, reason });

/**
 * A language-neutral, lossless lexer, not a parser or semantic validator.
 * Identifiers/numbers and quoted/comment text stay atomic: never blend two edits
 * inside e.g. `1000`, `customerId`, "a string", or a template literal.
 * All whitespace, including CRLF and indentation, is kept and compared exactly.
 */
export function tokenize(text) {
  const tokens = [];
  const re = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)|(?:\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|#[^\r\n]*)|(?:\r\n|\n|\r)|[^\S\r\n]+|(?:\d+(?:\.\d+)*(?:[eE][+-]?\d+)?[\p{L}\p{N}_$]*|[\p{L}\p{M}_$][\p{L}\p{M}\p{N}_$]*)|(?:>>>=|===|!==|\*\*=|<<=|>>=|&&=|\|\|=|\?\?=|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|\*\*|<<|>>>|>>|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|::|->|\.\.\.)|[\s\S]/gu;
  for (const match of text.matchAll(re)) {
    // An unclosed quote or block comment could make the token model misleading.
    // Stray quotes become one-character fallback matches and are refused.
    if (["'", '"', '`'].includes(match[0])) return null;
    if (match[0] === '/' && text[match.index + 1] === '*') return null;
    tokens.push(match[0]);
    if (tokens.length > LIMITS.tokens) return null;
  }
  if (tokens.join('') !== text) throw new Error('Lossless tokenization invariant failed');
  return tokens;
}
function withinBudget(a, b) {
  const counts = new Map();
  for (const t of b) counts.set(t, (counts.get(t) || 0) + 1);
  let pairs = 0;
  for (const t of a) { pairs += counts.get(t) || 0; if (pairs > LIMITS.matches) return false; }
  return true;
}
function changes(base, side) {
  return diffIndices(base, side).map(d => ({
    start: d.buffer1[0], end: d.buffer1[0] + d.buffer1[1], insert: d.buffer2Content,
  }));
}
function unambiguousChanges(base, side) {
  const forward = changes(base, side);
  const backward = changes([...base].reverse(), [...side].reverse()).map(d => ({
    start: base.length - d.end, end: base.length - d.start, insert: [...d.insert].reverse(),
  })).reverse();
  // Repeated tokens may have several LCS alignments. Do not choose one silently.
  // This is a conservative ambiguity heuristic, not a proof of unique alignment.
  return same(forward, backward) ? forward : null;
}
function apply(base, edits) {
  let at = 0;
  const out = [];
  for (const e of edits) { out.push(...base.slice(at, e.start), ...e.insert); at = e.end; }
  return [...out, ...base.slice(at)].join('');
}

export function mergeSimple(ours, base, theirs) {
  if (![ours, base, theirs].every(t => typeof t === 'string')) throw new TypeError('Expected three strings');
  if (ours === theirs) return { resolved: true, text: ours, rule: 'identical-change', edits: [] };
  if (ours === base) return { resolved: true, text: theirs, rule: 'only-theirs-changed', edits: [] };
  if (theirs === base) return { resolved: true, text: ours, rule: 'only-ours-changed', edits: [] };
  if (Math.max(ours.length, base.length, theirs.length) > LIMITS.characters) return failure('hunk-size-limit');
  if (!base || !ours || !theirs) return failure('competing-insertion-or-delete-modify');
  const [a, o, b] = [ours, base, theirs].map(tokenize);
  if (!a || !o || !b) return failure('token-limit-or-unclosed-literal');
  if (!withinBudget(o, a) || !withinBudget(o, b)) return failure('repeated-token-budget');
  const ac = unambiguousChanges(o, a), bc = unambiguousChanges(o, b);
  if (!ac || !bc) return failure('ambiguous-token-alignment');
  // Cross-check the diff representation before combining it.
  if (apply(o, ac) !== ours || apply(o, bc) !== theirs) throw new Error('Diff round-trip invariant failed');
  const edits = [];
  for (const e of [...ac.map(e => ({ ...e, side: 'ours' })), ...bc.map(e => ({ ...e, side: 'theirs' }))]
    .sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = edits.at(-1);
    if (previous && previous.start === e.start && previous.end === e.end && same(previous.insert, e.insert)) {
      previous.side = 'both'; continue;
    }
    // Also refuse touching edits: insertions at replacement boundaries have an
    // ordering ambiguity; adjacent lexical deletions may change token meaning.
    if (previous && e.start <= previous.end) return failure('overlapping-or-touching-token-edits');
    edits.push(e);
  }
  const text = apply(o, edits);
  const offsets = [0];
  for (const token of o) offsets.push(offsets.at(-1) + token.length);
  return { resolved: true, text, rule: 'disjoint-token-edits', edits: edits.map(e => ({
    side: e.side, baseStart: offsets[e.start], baseEnd: offsets[e.end],
    removed: o.slice(e.start, e.end).join(''), inserted: e.insert.join(''),
  })) };
}

export function markerSize(inputs) {
  let largest = 6;
  for (const input of inputs) {
    for (const m of input.matchAll(/^(?:<+|>+|\|+|=+)/gm)) largest = Math.max(largest, m[0].length);
  }
  return Math.max(7, largest + 1);
}

/** Parse only a freshly generated native candidate, never user-edited markers. */
export function refineDiff3(candidate, size = 7) {
  const lines = candidate.match(/[^\n]*\n|[^\n]+$/g) || [];
  const label = line => line.replace(/\r?\n$/, '');
  const start = '<'.repeat(size) + ' OURS', middle = '|'.repeat(size) + ' BASE';
  const separator = '='.repeat(size), end = '>'.repeat(size) + ' THEIRS';
  const control = new Set([start, middle, separator, end]);
  const out = [], hunks = [];
  let resolved = 0;
  for (let i = 0; i < lines.length;) {
    if (label(lines[i]) !== start) {
      if (control.has(label(lines[i]))) return { valid: false, reason: 'unexpected-marker', text: candidate, hunks: [] };
      out.push(lines[i++]); continue;
    }
    const first = i++;
    const parts = [];
    for (const expected of [middle, separator, end]) {
      const body = [];
      while (i < lines.length && !control.has(label(lines[i]))) body.push(lines[i++]);
      if (i >= lines.length || label(lines[i]) !== expected) return { valid: false, reason: 'malformed-diff3', text: candidate, hunks: [] };
      i++; parts.push(body.join(''));
    }
    if (hunks.length >= LIMITS.hunks) return { valid: false, reason: 'hunk-count-limit', text: candidate, hunks: [] };
    const decision = mergeSimple(parts[0], parts[1], parts[2]);
    hunks.push({ id: hunks.length + 1, nativeStartLine: first + 1, nativeEndLine: i,
      resolved: decision.resolved, rule: decision.rule, reason: decision.reason, edits: decision.edits });
    if (decision.resolved) { resolved++; out.push(decision.text); }
    else out.push(...lines.slice(first, i)); // Preserve the entire unresolved block, including BASE.
  }
  return { valid: true, text: out.join(''), hunks, resolved, remaining: hunks.length - resolved };
}

export function refineNative(candidate, inputs, size = 7) {
  // merge-file adds separator newlines to unterminated conflict sections. Handle
  // a whole single-line file directly, without fabricating a final newline.
  if (inputs.every(t => !t.includes('\n') && !t.includes('\r'))) {
    const d = mergeSimple(inputs[0], inputs[1], inputs[2]);
    return { valid: true, text: d.resolved ? d.text : candidate, resolved: d.resolved ? 1 : 0,
      remaining: d.resolved ? 0 : 1, hunks: [{ id: 1, resolved: d.resolved, rule: d.rule, reason: d.reason, edits: d.edits }] };
  }
  if (inputs.some(t => !t.endsWith('\n'))) return { valid: false, reason: 'mixed-or-unterminated-multiline-eof', text: candidate, hunks: [] };
  return refineDiff3(candidate, size);
}
