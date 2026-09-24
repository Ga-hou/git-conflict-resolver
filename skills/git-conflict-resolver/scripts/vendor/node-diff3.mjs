/**
 * Extracted LCS and diffIndices from bhousel/node-diff3/src/diff3.mjs.
 * Upstream commit: 8226c27e074909241d72276c21215505a931665f
 * Upstream Git blob: 7b43ba56eaf242444384ce940da3cef944761922
 * Changes: retain only these two functions; replace the export list; add this header.
 * Function bodies are unchanged. MIT license: ./node-diff3.LICENSE.md
 * Copyright (c) 2006, 2008 Tony Garnock-Jones and LShift Ltd.
 * Copyright (c) 2019-2026 Bryan Housel.
 */
export { LCS, diffIndices };

// Text diff algorithm following Hunt and McIlroy 1976.
// J. W. Hunt and M. D. McIlroy, An algorithm for differential buffer
// comparison, Bell Telephone Laboratories CSTR #41 (1976)
// http://www.cs.dartmouth.edu/~doug/
// https://en.wikipedia.org/wiki/Longest_common_subsequence_problem
//
// Expects two arrays, finds longest common sequence
function LCS(buffer1, buffer2) {
  // Use a prototype-less object so input elements that happen to match
  // `Object.prototype` members (`constructor`, `__proto__`, `toString`, ...)
  // don't shadow the lookup with inherited values.
  let equivalenceClasses = Object.create(null);
  for (let j = 0; j < buffer2.length; j++) {
    const item = buffer2[j];
    if (equivalenceClasses[item]) {
      equivalenceClasses[item].push(j);
    } else {
      equivalenceClasses[item] = [j];
    }
  }

  const NULLRESULT = { buffer1index: -1, buffer2index: -1, chain: null };
  let candidates = [NULLRESULT];

  for (let i = 0; i < buffer1.length; i++) {
    const item = buffer1[i];
    const buffer2indices = equivalenceClasses[item] || [];
    let r = 0;
    let c = candidates[0];

    for (const j of buffer2indices) {
      let s;
      for (s = r; s < candidates.length; s++) {
        if ((candidates[s].buffer2index < j) && ((s === candidates.length - 1) || (candidates[s + 1].buffer2index > j))) {
          break;
        }
      }

      if (s < candidates.length) {
        const newCandidate = { buffer1index: i, buffer2index: j, chain: candidates[s] };
        if (r === candidates.length) {
          candidates.push(c);
        } else {
          candidates[r] = c;
        }
        r = s + 1;
        c = newCandidate;
        if (r === candidates.length) {
          break; // no point in examining further (j)s
        }
      }
    }

    candidates[r] = c;
  }

  // At this point, we know the LCS: it's in the reverse of the
  // linked-list through .chain of candidates[candidates.length - 1].

  return candidates[candidates.length - 1];
}

// We apply the LCS to give a simple representation of the
// offsets and lengths of mismatched chunks in the input
// buffers. This is used by diff3MergeRegions.
function diffIndices(buffer1, buffer2) {
  const lcs = LCS(buffer1, buffer2);
  let result = [];
  let tail1 = buffer1.length;
  let tail2 = buffer2.length;

  for (let candidate = lcs; candidate !== null; candidate = candidate.chain) {
    const mismatchLength1 = tail1 - candidate.buffer1index - 1;
    const mismatchLength2 = tail2 - candidate.buffer2index - 1;
    tail1 = candidate.buffer1index;
    tail2 = candidate.buffer2index;

    if (mismatchLength1 || mismatchLength2) {
      result.push({
        buffer1: [tail1 + 1, mismatchLength1],
        buffer1Content: buffer1.slice(tail1 + 1, tail1 + 1 + mismatchLength1),
        buffer2: [tail2 + 1, mismatchLength2],
        buffer2Content: buffer2.slice(tail2 + 1, tail2 + 1 + mismatchLength2)
      });
    }
  }

  result.reverse();
  return result;
}
