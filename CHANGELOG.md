# Changelog

## 0.2.0 — 2026-09-23

- Directly reuse pinned MIT `node-diff3` LCS and diffIndices primitives; retain the license in standalone installations and add a machine-readable provenance record.
- Refine native Git diff3 conflict hunks with lossless token-level comparison inspired by IDEA's word-level simple-conflict approach. No IDEA code is ported.
- Apply simple hunks even when another hunk in the same file needs the Agent; preserve all original unmerged index stages until the file is fully resolved.
- Keep identifiers, numbers, quoted literals and recognized comments atomic; refuse overlapping/touching edits, competing insertions, ambiguous alignments and oversized work.
- Add `--dry-run`, `--native-only`, per-hunk explanations, partial-progress idempotency and snapshot-integrity checks.
- Add an exact whole-file one-side-result guard and hash-bound, evidence-bearing `review` exceptions; these do not prove semantics.
- Preserve v0.1's worktree/index protection, commit-intent context and history-safe submodule preparation/pinning.
- Add real Git merge/rebase/cherry-pick tests, lexical tests, and a reproducible two-conflict-to-one demonstration.

## 0.1.0 — 2026-09-23

Initial context, native clean three-way merge, Agent intent workflow and safe submodule pinning. This version did not implement IDEA-like fine-grained conflict refinement.
