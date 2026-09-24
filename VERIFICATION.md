# Verification record — v0.2.0

Linux baseline: 2026-09-23. macOS publication checks: 2026-09-24.

## Linux baseline

- OS: Linux.
- Node.js: v22.16.0. Git: 2.47.3.
- `node scripts/check.mjs`: passed; 10 JavaScript files, Skill metadata and vendored source/license hashes checked.
- `node --test test/resolver.test.mjs test/refinement.test.mjs test/simple-merge.test.mjs`: **74 tests passed, 0 failed, 0 skipped**.
- `node scripts/demo.mjs`: passed in an isolated temporary Git repository.

Evidence: [linux-node22.tap](verification/linux-node22.tap), [syntax-check.txt](verification/syntax-check.txt), [demo.json](verification/demo.json).

The suite retains 38 original tests, adds 20 lexical/refinement tests and 16 real-Git integration tests. One lexical test checks 250 deterministic generated independent-field edit pairs in both side orders; these are subcases, not 250 additional reported tests. All test repositories are temporary and local. No user repository is used as a test fixture.

### New functionality demonstrated

1. A real `git merge` first reports a conflict on a single line with independent `retries` and `timeout` edits. v0.2.0 combines both values. `--native-only` leaves that conflict unresolved.
2. In a real two-hunk conflict, v0.2.0 resolves the independent-field hunk while leaving a competing `mode` edit unresolved. The original stage-1/2/3 index records remain exactly unchanged. The separate demo reports **2 conflict blocks before, 1 after**.
3. Competing edits to one number, identifier, quoted literal or recognized comment are not character-blended. Repeated-token ambiguity, malformed markers and size limits are refused.
4. Repeated invocation preserves partial progress. Manual edits made before or after preparation are not overwritten. Dry-run leaves target files and index unchanged.
5. Real merge, rebase and cherry-pick fixtures, CRLF, no-final-newline single-line files, exact staging, unrelated staged content, known lockfile skipping, and snapshot tampering are covered.
6. Exact whole-file side acceptance is refused by `verify` unless the result has a matching, evidence-bearing review record. A stale record does not approve a changed staged result.
7. Original submodule divergence/fast-forward/local-history/pin ancestry checks and safety tests continue to pass.

Original native-clean-merge unit cases include deliberately constructed unmerged index entries. The new refinement integration cases above instead start with genuine Git-created conflicts; do not confuse the two kinds of evidence.

## macOS publication checks

- OS: macOS. Node.js: v22.22.3. Git: 2.54.0 (Apple Git-157).
- `npm test -- --test-reporter=tap`: **74 tests passed, 0 failed, 0 skipped**.
- `npm run check`: passed; 10 JavaScript files, skill metadata and vendored hashes checked.
- `node scripts/demo.mjs`: passed; two real conflict blocks became one, and the original unmerged index was preserved.
- Both READMEs passed checks for relative links, balanced code fences, JSON examples, and reciprocal language links. The default README is English; `README-zh.md` retains the Chinese documentation.
- Eight isolated publishing-helper checks passed using simulated subprocess results, with no network or Git writes: private default, explicit public creation, invalid arguments, account/existing-repository guards, and visibility mismatch detection. Both creation paths include `README-zh.md`.

The first macOS run exposed a CLI entrypoint bug: Node resolved the installed script through `/private/var`, while the command-line path used `/var`. The script exited without invoking the CLI. Entry detection now compares real filesystem paths, and the installer test also checks an explicit directory symlink (a junction on Windows). The full suite passed after the fix.

Evidence: [macos-node22.tap](verification/macos-node22.tap), [macos-check.txt](verification/macos-check.txt), [macos-demo.json](verification/macos-demo.json).

## CI and publishing

GitHub Actions has six jobs: macOS, Ubuntu and Windows, each with Node 22/24. The local records above cover Linux and macOS with Node 22. See [GitHub Actions](https://github.com/Ga-hou/git-conflict-resolver/actions) for actual matrix results; configuration alone does not establish a pass. POSIX-specific tests intentionally skip unsupported filename/symlink cases on Windows. Actions are pinned to official release commits: checkout v7.0.1 and setup-node v7.0.0.

The original Linux verification did not create or push a GitHub repository. The owner-run `scripts/publish.mjs` helper now accepts an explicit `--public` flag for `Ga-hou/git-conflict-resolver`, defaults to private without that flag, and refuses an existing target or remote. Publishing is a separate, explicitly authorized operation, never part of the resolver tests.

## What these results do not establish

This is not an exact IDEA implementation, an AST merge engine, a measured automatic resolution rate on production repositories, or a semantic correctness proof. No Mergiraf executable was integrated or tested.

Preserving disjoint token edits or both submodule histories does not prove that their combined behavior is correct. The exact whole-side-result check does not detect all semantic loss or all per-hunk side acceptance. An Agent can still make a bad decision or provide an inaccurate review. Relevant project tests and actual intent review are required.

The resolver is not a security sandbox or a transaction manager for unrelated concurrent Git clients. Filesystem/custom-driver compatibility and remote availability of submodule commits remain separate concerns.

The package includes source hashes for reproducibility; hashes establish file identity, not security or semantic correctness.
