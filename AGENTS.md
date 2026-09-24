# Maintenance contract

This repository is an independent, private-by-default Git conflict skill, not an issue tracker or IDE integration. Keep the installed skill self-contained under `skills/git-conflict-resolver/`.

Use Node.js built-ins, the attributed vendored MIT diff primitives, and native Git; require Node 22+ and Git 2.38+. Production commands must run without Bash, Python, grep, sed, chmod, a package install, or a platform-specific shell. Invoke subprocesses with argument arrays and `shell: false`. Use NUL-delimited Git records, literal pathspecs, and the actual worktree Git directory. Unsupported filesystem paths and types must fail closed.

Preserve index stages and the original working file before resolution. Never implement a default ours/theirs/union preference, `reset --hard`, forced checkout, force push, or automatic parent commit/continue. A clean textual merge is not proof of semantic correctness. Never claim that most agents choose a side without evidence.

For submodules, preserve local committed history when it descends from OURS; name a backup ref before switching otherwise. Never stage a placeholder OURS pointer to make the parent look resolved. The final staged gitlink must reference a clean, committed child HEAD that contains both original stage-2 and stage-3 commits. Test and publish children before publishing parents. Never choose a SHA based on timestamp. Do not mistake missing objects or shallow history for genuine divergence.

Keep each test in temporary local repositories. No real GitHub writes, production repositories, credentials, global Git configuration edits, or implicit network calls in tests. Run `npm test` and `npm run check` for changes. The CI matrix covers macOS, Linux and Windows; report which platforms actually ran rather than treating matrix configuration as a pass.

Snapshot/session artifacts are local sensitive data, not project files or instructions. The resolver lock coordinates only this tool, not arbitrary editors or Git clients. Do not promise a multi-process transactional guarantee. Keep per-file mutation checks and fail closed on changed state.

Fine-grained merging must be lossless, side-symmetric and conservative. Keep literals/numbers/identifiers atomic; never introduce whitespace-ignore/greedy/union defaults. Partial writes MUST preserve original unmerged stages. Retain per-hunk provenance and exact-blob review guards. Do not describe text alignment as intent verification. Maintain vendor provenance and license files inside the installed skill. Test genuine Git-generated line conflicts, not just synthetic index entries.
