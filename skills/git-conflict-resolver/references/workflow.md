# Workflow details, boundaries and recovery

## Inputs and operation identity

The source of truth is `git ls-files -u -z`: stages 1, 2, and 3 retain base, ours and theirs. A missing stage is meaningful. The script detects normal merges, current rebase steps, cherry-picks, and index-only conflicts. Revert and octopus contexts are exported but not auto-resolved. Merge commits replayed with `--rebase-merges` or cherry-pick `-m` require inspecting the actual staged base; do not assume the first parent. Multiple merge bases are reported rather than silently choosing one for file merging.

A worktree-specific session lives under the path returned by `git rev-parse --absolute-git-dir`, in `agent-conflict-resolver/sessions/<uuid>/`. `.git` may be a file: never build `.git/...` paths yourself. Every session keeps original versions and a working-file backup in hashed path directories, so duplicate basenames and unusual path characters do not collide. Full paths remain in the manifest. Context is local sensitive data and should not be committed, uploaded to an Issue, or copied into a public log.

`prepare` is idempotent within one operation. It does not resnapshot over the original backup after manual edits. If index stages change unexpectedly, inspect the change and use `prepare --new` only when a new baseline is intended. Old sessions are retained. A new HEAD/replay/merge identity gets a new session automatically. `verify` is intended **before** parent commit or continue; afterward the old session is intentionally stale.

Logs are bounded to 40 commits per side **per path**. They do not follow every possible rename and do not replace repository-wide understanding. Files beyond process buffer limits and non-UTF-8 pathnames may cause a safe refusal rather than partial context. The automatic text path accepts UTF-8 files up to 8 MiB; larger/binary/custom-encoded files require their native workflow.

## Why automatic resolution is conservative

Ordinary Git merge has already performed most clean line merges. v0.2.0 retains that native first pass but additionally refines individual remaining diff3 hunks using lossless tokens. Identifiers, numbers, recognized quoted text and comments are atomic; whitespace is retained exactly. The vendored node-diff3 LCS/diffIndices calculate BASE-to-OURS and BASE-to-THEIRS edits. Forward/reverse alignments must agree, original-side reconstruction must match, and different edits may not overlap or touch. Identical edits are coalesced. This is a conservative heuristic, not an AST, unique-alignment proof or semantic check.

The entire native hunk is retained when any of its token edits remain ambiguous. Fully solved files are staged precisely. Partially solved files receive only working-tree updates: the full original unmerged stages remain. The session journals partial writes, keeps worktree.before, and records lastAutoHash; repeats do not overwrite an unchanged partial result or a later human edit. A dry-run saves candidates/context but writes neither target files nor the index. --native-only disables refinement.

Automatic writes still require pristine AUTO_MERGE proof, unchanged index records and working hashes, ordinary attributes and intact saved blobs. Binary/custom-encoded/LFS/symlink paths stay manual. Typical lockfiles, minified files and source maps skip token refinement. Other generated paths require Agent classification. Fine-grained limits are 64 KiB per hunk, 2048 tokens per side, 16384 cross-token matches per pair, and 256 hunks per candidate. Unsafe EOF reconstruction (mixed or unterminated multiline) is refused; a no-newline single-line file is handled directly. A marker-size collision is avoided by scanning inputs. Markers exceeding the size budget stay manual.

Source choices and exact upstream commits are documented in research.md and ../THIRD_PARTY_NOTICES.md. No IDEA greedy or whitespace-ignore path, Mergiraf integration, rerere acceptance or AI API was added.

`verify` checks unresolved index entries, both staged and working `diff --check`, complete standard marker blocks, and staged/worktree mismatches for the original files. A literal conflict-block example in documentation may trigger a false positive: inspect it; never delete legitimate content just to satisfy a check. A staged text result exactly equal to one side, when both sides changed, additionally requires a hash-and-mode-bound review note with both intents, actual check disclosures and a supersession reason. It is an exact-blob guard, not a semantic validator or a block-level loss detector. These checks cannot prove intent preservation, generated-file consistency, runtime behavior, or the safety of a binary. That is the agent's review and project-test responsibility.

## Submodules

For original gitlinks O and T, a valid final commit M must satisfy both `merge-base --is-ancestor O M` and `merge-base --is-ancestor T M`. If either side contains the other, a reviewed fast-forward candidate is sufficient. If histories diverge, create a true merge commit in the child. An existing common descendant is eligible only after its additional changes have been reviewed. Do not use timestamps, branch names, or a bare `update --remote` to determine the pin.

A clean local child HEAD that contains O is used as the starting point, preserving already-committed local changes. If it does not contain O, a `conflict-backup/...` ref preserves the old HEAD before a dedicated `conflict-resolve/...` branch is created. Backup and resolution branches are not deleted automatically. Uncommitted work blocks preparation. The script does not perform an implicit stash because untracked files, nested submodules and generated artifacts make that an unsafe default.

Initialization is explicit: `submodule-prepare --init --url <trusted-url>` clones without checkout and then checks out O. It does not replace a nonempty directory or infer a URL from unresolved `.gitmodules`. It creates an embedded child `.git` directory; after everything is resolved, an authorized `git submodule absorbgitdirs -- <path>` can convert it to the modern layout. If a clone does not contain the original O/T commits, retrieve the correct objects; do not substitute its default branch.

Fetching is explicit and remote-specific. Missing commits and shallow repositories are refusals, not divergence. The script never enables the `file` or `ext` protocol globally and never fetches all configured remotes automatically. Local test fixtures enable the file protocol only for the exact test command that needs it.

Parent pointers remain unmerged during child work. The final `submodule-pin --reviewed` requires clean child state, no unfinished Git operation, and both ancestor proofs. It does not publish the commit. Review source-code compatibility in the parent and run integration tests after all child pins are ready. For nested submodules, repeat this depth-first, committing and pinning each child before its parent.

Publish only under the user's delivery authorization: push the child integration branch to its intended remote, confirm the SHA is fetchable from a suitable ref, then push its parent. `git push --recurse-submodules=check` is an additional guard, not a guarantee that every consumer has access to the same remote. `on-demand` can push children automatically but needs correct remotes and branches; do not blindly invoke it on a temporary resolution branch.

## Recovery and concurrency

Never restore the whole index from a saved file over unrelated staged work. The saved `initial-index.txt` is diagnostic NUL-delimited metadata, not an index binary. Original blobs remain in Git and in the session. Working-file backups are named `worktree.before`. Compare and restore individual paths only after deciding which later edits to preserve.

A resolver process uses a per-worktree `command.lock`. If interrupted, confirm the recorded process is no longer running before removing a stale lock. The lock does not control an IDE, another Git client, or a different worktree. Do not run competing resolution agents on the same worktree; use one writer. Per-file hashes and stage checks detect many changes but do not make the operation fully transactional.

Before a submodule switch, the manifest records its original HEAD and a named backup ref. If preparation is interrupted, inspect those refs and the current operation instead of repeating forceful checkout commands. A repeated normal preparation on the same managed branch resumes without resetting a partially resolved merge.

## Sources checked while implementing

- Git merge / index stages: https://git-scm.com/docs/git-merge
- NUL-delimited index records: https://git-scm.com/docs/git-ls-files
- Native file merge semantics and exit codes: https://git-scm.com/docs/git-merge-file
- Rebase side labels: https://git-scm.com/docs/git-rebase
- Submodule merge and publication workflow: https://git-scm.com/book/en/v2/Git-Tools-Submodules
- Submodule commands: https://git-scm.com/docs/git-submodule
- Exact index updates: https://git-scm.com/docs/git-update-index
- AUTO_MERGE comparison: https://git-scm.com/docs/git-diff
