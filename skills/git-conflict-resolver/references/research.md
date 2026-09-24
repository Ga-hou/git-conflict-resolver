# Open-source research and implementation provenance

Researched: 2026-09-23. Public source inspection, not a claim about all Agent behavior or comparative product success rates. No evidence was obtained that “most Agents default to accepting one side”; that is a failure mode this tool mitigates, not a measured prevalence claim.

## 1. JetBrains/intellij-community — algorithm inspiration, not copied code

Repository: https://github.com/JetBrains/intellij-community

Pinned source revision: `726ef46761f696682ee4a67767bd089b2566c877`.

- https://github.com/JetBrains/intellij-community/blob/726ef46761f696682ee4a67767bd089b2566c877/platform/util/diff/src/com/intellij/diff/comparison/MergeResolveUtil.kt
- https://github.com/JetBrains/intellij-community/blob/726ef46761f696682ee4a67767bd089b2566c877/platform/util/diff/src/com/intellij/diff/comparison/ComparisonMergeUtil.kt
- Official user-facing explanation: https://www.jetbrains.com/help/idea/resolve-conflicts.html

Observed: SimpleHelper uses word-level comparison and rejects unresolved conflict ranges. tryResolve tries DEFAULT and then IGNORE_WHITESPACES. A separate GreedyHelper takes a more permissive insertion/deletion approach and the source explicitly assumes user review/undo and acknowledges an increased risk of incorrect resolution. Different concurrent insertions cannot be ordered merely by choosing left-first or alphabetical order. ComparisonMergeUtil dispatches via a configuration flag; this research did not establish the flag's default for every IDEA version.

Adopted: finer-than-line comparison, rejection of uncertain overlap, and side-symmetric composition. Deliberately NOT adopted: whitespace ignoring, greedy deletions, or IDEA's platform dependencies. Our lexer, hunk parser, overlap checks, ambiguity budgets and state handling were written for this project. No JetBrains source body or test fixture was copied. The observed source carries an Apache-2.0 header; our implementation is not a licensed code port or a behavioral equivalence claim.

## 2. bhousel/node-diff3 — directly reused code (MIT)

Repository: https://github.com/bhousel/node-diff3

Pinned commit: `8226c27e074909241d72276c21215505a931665f`.

- Source: https://github.com/bhousel/node-diff3/blob/8226c27e074909241d72276c21215505a931665f/src/diff3.mjs
- Source Git blob: `7b43ba56eaf242444384ce940da3cef944761922`
- License: https://github.com/bhousel/node-diff3/blob/8226c27e074909241d72276c21215505a931665f/LICENSE.md
- License Git blob observed: `3f1bd62056354b921340e342697ad1c6541dbf00`

Direct reuse: the LCS and diffIndices function bodies. The distributed excerpt has a reduced export list, a provenance header and the relevant source comments. Its file hash therefore differs from the complete upstream source blob. The algorithm is identified upstream as following Hunt and McIlroy's 1976 text differencing work; we rely on the reviewed implementation, not a freshly claimed reinvention.

Why only the core: this project needs lossless token arrays and strict overlap decisions. The library's default string splitting uses whitespace separators; using that directly would discard whitespace. Its high-level marker serialization is also not a substitute for preserving Git's original unmerged index and partial progress. We therefore call diffIndices on explicit lossless arrays, then perform our own conservative composition.

MIT attribution and full permission notice are included under scripts/vendor and in the installed skill. No runtime download, npm installation or build step is needed. Prototype-name tokens such as __proto__ and constructor are regression-tested.

## 3. Peaker/git-mediate — workflow reference only

Repository: https://github.com/Peaker/git-mediate

The README's diff3 workflow keeps BASE visible and exposes both changes. It mechanically resolves conflicts once editing makes one side unchanged relative to BASE, and describes automatically staging fully resolved files. The repository identifies a GPL-2.0 license.

Adopted at the conceptual level: preserve the three sides and evidence, recognize equality/one-side-unchanged cases, and stage only after a file is fully resolved. No Haskell/GPL code was copied or linked. Our script does not edit the BASE to manufacture an easier conflict: the saved original base and index remain authoritative.

## 4. Mergiraf — evaluated, not integrated in v0.2.0

Official upstream: https://codeberg.org/mergiraf/mergiraf

Official documentation:
- https://mergiraf.org/
- https://mergiraf.org/usage.html

GitHub search surfaced https://github.com/qundao/mirror-mergiraf — explicitly a mirror, NOT the official repository.

Observed: syntax-tree-aware merging, Git merge-driver integration, and a post-conflict `mergiraf solve` workflow. Results still require review. Official documentation warns that its reconstruction works best with diff3, not zdiff3, because extracting common context can leave an invalid reconstructed BASE.

Why not included now: the default skill is a self-contained Node + Git implementation. A syntax-aware external executable introduces additional packaging, supported-language and platform validation requirements. No Mergiraf binary was available/run in this environment, so this release makes no tested Mergiraf claims. It has no AST capability. A future external integration must use preserved three-way inputs/candidates, not overwrite existing Agent progress or silently auto-stage results.

## Implementation map

| Capability | Source / implementation |
| --- | --- |
| Native merge, stage records, ancestry | Git built-ins; existing v0.1 orchestration |
| LCS and two-way difference ranges | Direct MIT node-diff3 excerpt |
| Word-level second pass | IDEA-inspired independent implementation in simple-merge.mjs |
| Lossless lexical units, exact whitespace, atomic literals | This project's conservative tokenizer |
| Reverse-alignment check and bounded work | This project's safety heuristics |
| Partial hunk write / unchanged unmerged index | This project's resolver integration |
| Whole-side result review tied to staged hash | This project's structural guard |
| Submodule local history preservation and final pin | Existing Git ancestry workflow, retained and regression-tested |

The new tests demonstrate additional resolutions on genuine Git conflicts. They do not establish equality with IDEA, a generalized auto-resolution rate, or semantic correctness.
