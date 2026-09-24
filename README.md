# Git Conflict Resolver v0.2.0

English | [简体中文](README-zh.md)

**An Agent skill with cross-platform Node.js scripts: resolve simple conflict hunks first, then let the Agent handle the remaining conflicts using both sides' commit intent.**

v0.2.0 goes beyond rerunning `git merge-file`. It adds IDEA-inspired **word-level refinement** to combine independent field edits on the same line. If only part of a file can be resolved, it preserves the remaining conflicts and the original index stages. It is not a port of IDEA's full algorithm or an AST/semantic merge engine.

## Requirements and installation

Requires **Node.js 22+** and **Git 2.38+**. No npm install, Bash, Python, IDE, cloud AI API, or native compilation is required. The MIT-licensed `node-diff3` primitives are bundled with the skill, which can run offline after installation.

Use the same commands in a terminal on macOS, Linux, or Windows:

```text
git clone https://github.com/Ga-hou/git-conflict-resolver.git
cd git-conflict-resolver
node scripts/install.mjs --to "<your Agent skills directory>"
```

The installer copies the complete `git-conflict-resolver` skill, including scripts, vendored code, and documentation. It refuses to overwrite an existing installation; explicitly migrate or move the old installation before installing a new version. During development, you can also run the scripts directly from this repository.

## Quick start

The target repository must already have conflicts from a merge, rebase, or cherry-pick:

```text
node skills/git-conflict-resolver/scripts/resolve.mjs run --repo "<target repository>"
```

Preview candidates without changing working files or the index:

```text
node skills/git-conflict-resolver/scripts/resolve.mjs run --repo "<target repository>" --dry-run
```

`--dry-run` still saves context, backups, and candidates in the worktree's actual Git directory. It does not mean zero disk writes.

To compare with native whole-file merging without word-level refinement:

```text
node skills/git-conflict-resolver/scripts/resolve.mjs run --repo "<target repository>" --native-only
```

Commands return JSON. `remaining` lists files that still need attention; exit code 0 means the command succeeded, not that all conflicts are resolved. **The tool does not automatically commit, continue, or push the parent repository.**

## How it works

```text
Existing Git conflicts
  → Save stages 1/2/3, original working files, both sides' commit messages and patches
  → Check AUTO_MERGE, file hashes, index state, and attributes to protect manual progress
  → Run Git's native three-way line merge
  → Refine each remaining native diff3 conflict hunk with lossless token comparison
      ├─ Identical edits / only one side actually changed: use the determined result
      ├─ Non-overlapping token edits against BASE: combine them
      └─ Overlaps, unclear adjacent boundaries, or ambiguous repeated tokens: keep the hunk
  → Fully resolved file: stage exactly that file
  → Partially resolved file: update only the worktree; preserve all original stages 1/2/3
  → Agent reviews both sides' intent, resolves remaining conflicts, and runs relevant tests
  → Handle submodules from the inside out; pin a commit containing both histories last
  → verify checks Git state and conspicuous whole-side replacement
```

Applied refinements are recorded in `refinement.json`, including the rule, line numbers in the native candidate, and BASE character offsets for both sides' token edits. `candidate.native.diff3` holds the native result, `candidate.diff3` holds the refined result, and `worktree.before` holds the original backup. File artifacts use digest-named directories; actual paths are recorded in `manifest.json`.

## What changes from v0.1

```javascript
// BASE
const options = { retries: 2, timeout: 1000 };
// OURS
const options = { retries: 3, timeout: 1000 };
// THEIRS
const options = { retries: 2, timeout: 2000 };
// v0.2.0
const options = { retries: 3, timeout: 2000 };
```

The tests create real Git branches and confirm that `git merge` produces a conflict before running the resolver and checking this result. They do not merely construct an index for an already mergeable case.

If another hunk in the same file changes `mode = "base"` to `"ours"` and `"theirs"`, the resolver combines the independent field edits above, keeps the `mode` conflict, and preserves the file's unmerged index. If any token edit in a native hunk cannot be merged, that entire hunk stays intact; the tool does not force inline conflict markers into it.

## Conservative token merging

Numbers, identifiers, quoted strings, template text, and recognized comments are atomic tokens: `100 → 120` and `100 → 103` will not become `123`; `foo → food` and `foo → fool` will not become `foold`. Whitespace and indentation are preserved exactly. The resolver does not enable ignore-whitespace, union, or IDEA-style greedy deletion merging.

The tokenizer is a conservative, language-independent approximation. It does not implement every language's full lexical grammar, such as complex regular-expression literals or nested template syntax. It cannot prove that code parses or behaves correctly. Agreement between forward and reverse LCS alignments is a heuristic to reduce ambiguity, not mathematical proof of a unique alignment.

Large hunks, excessive token counts, highly repetitive content, malformed markers, and multi-line EOF cases with mixed or missing newlines stop token refinement. Single-line files without a final newline have dedicated handling. Common lockfiles, minified files, and source maps skip token refinement; the Agent must identify other generated files and follow the project's generation process. Binary files, LFS, symlinks, and custom merge/filter/encoding settings retain their dedicated handling boundaries.

## Guarding against whole-side acceptance

The skill requires the Agent to consider both sides' commit intent for every file. The script adds a check: **when both sides changed from BASE but the final staged file is byte-for-byte identical to one side**, `verify` refuses to pass without a review record.

When accepting a whole side is justified, provide a local JSON review note. No commands in the note are executed:

```json
{
  "oursIntent": "The specific behavior our side needs to preserve",
  "theirsIntent": "The specific behavior the other side needs to preserve",
  "resolution": "How the final implementation meets these requirements",
  "supersedes": "Why accepting this whole side preserves or justifiably supersedes the other requirement",
  "checks": ["Checks actually run and their results; explain any checks not run"]
}
```

```text
node skills/git-conflict-resolver/scripts/resolve.mjs review --repo "<repository>" --path "src/file.ts" --note "<review.json>"
node skills/git-conflict-resolver/scripts/resolve.mjs verify --repo "<repository>"
```

The record is bound to the final staged blob hash and file mode. Changing the staged result invalidates the old record. This check catches the conspicuous case of **a whole file exactly matching one side**; it cannot detect all hunk-level side acceptance or prevent an Agent from inventing a justification or evading the check with formatting changes. Review and project tests remain necessary; this is not a semantic correctness guarantee. Ordinary merged results do not require this additional structured record, but still require the skill's intent review.

## Submodules

```text
node skills/git-conflict-resolver/scripts/resolve.mjs submodule-prepare --repo "<parent repository>" --path "<submodule>"
```

If the local committed HEAD contains OURS, it is preserved preferentially; otherwise, a backup ref is created before preparing a resolution branch. Dirty worktrees, missing objects, and shallow history are not treated as permission to overwrite or as proof of divergence. Explicitly pass `--fetch --remote origin` when fetching is needed. For an uninitialized submodule, use `--init --url <trusted-url>` with a verified URL. The script does not guess a remote.

Run this skill recursively inside the submodule, complete review and tests, and make the authorized local commit. Then:

```text
node skills/git-conflict-resolver/scripts/resolve.mjs submodule-pin --repo "<parent repository>" --path "<submodule>" --reviewed
```

The final commit must contain both commits referenced by the parent repository's original stage-2 and stage-3 entries. **The tool does not choose the "latest SHA" by timestamp**, or temporarily stage an OURS pointer to make the parent appear resolved. Publishing requires separate authorization: make the child commits available remotely before publishing the parent.

## Open-source foundations

See [RESEARCH.md](RESEARCH.md) for the research, permanent source links, revisions, and scope of adoption.

- **JetBrains/intellij-community**: informed the word-level conflict approach in `MergeResolveUtil` and the rule against guessing ambiguous insertion order. No Kotlin/Java implementation was copied, and identical results to IDEA are not claimed.
- **bhousel/node-diff3**: the original function bodies of `LCS` and `diffIndices` are directly reused, pinned to verified commit and blob IDs. Only exports and attribution were adjusted. The full MIT license is distributed with the skill.
- **Peaker/git-mediate**: informed the workflow of keeping BASE, showing both sides' changes, and mechanically resolving only cases that reduce to unambiguous edits. No code was copied.
- **Mergiraf**: syntax-aware merging and the post-conflict `solve` workflow were evaluated. This version does not integrate or bundle its executable or source. Complex moves and AST merging remain the Agent's responsibility. Its official source is hosted on Codeberg; GitHub mirrors are not the official repository.

## Verification and limitations

```text
npm test
npm run check
node scripts/demo.mjs
```

`demo.mjs` creates two real conflicts in a temporary repository and demonstrates resolving one while retaining the other. It does not access the network or modify user repositories. See [VERIFICATION.md](VERIFICATION.md) for test results and platforms actually run. CI is configured for macOS/Linux/Windows × Node 22/24; a configured platform is not a passing result until it has run.

The tool is not an execution sandbox and does not provide transactional isolation from other Git clients. Avoid concurrent writes to the same worktree by other Agents or editors. After an interruption, inspect local session backups and the journal; do not force a reset.

## License

This project is licensed under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party attribution and licenses.
