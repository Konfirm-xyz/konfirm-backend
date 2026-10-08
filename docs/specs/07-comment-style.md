# Spec 7: Comment style

**Status:** decision needed, on whether to adopt the rule and how far to clean up.
**Priority:** low. Maintainability, not correctness.

## The facts

About 1,700 of roughly 9,500 non-blank lines in `src/` and `reconciler/src/` are comments, about 18%. Many comment blocks run 10 to 20 lines, and many describe history ("this used to", "was removed when", "earlier in the project"). History belongs in git, not in the code.

Stale comments were the real problem, and those are fixed. What remains is length and history narration.

## The rule

1. **Comments say why, not what, and not when.** A comment that explains a non-obvious constraint, a security reason, or an external quirk stays. A comment that narrates how the code got here goes.
2. **Blocks are at most 6 lines.** Module headers may be longer, up to 12 lines.
3. **No history words in comments:** "used to", "previously", "was removed", "originally", "earlier", "this session". Git has the history.
4. **Reference real things.** A comment that points at a file, function, or spec should name one that exists. A check in CI can catch missing ones.

## Options

**A. Adopt the rule and clean up everything.** One large change, hard to review, risks deleting a useful sentence.

**B. Adopt the rule for new code only.** Zero cost. Old comments stay long until someone touches them.

**C. Adopt the rule and clean up one directory per pull request.** Reviewable, and each diff only touches comments, so it can't change behaviour.

## Recommendation

**Option C, starting with the files most touched by recent work** (`src/payments`, `src/fees`, `src/common`, `reconciler/src/store.rs`). Adopt the rule for new code now (B), so the amount of history stops growing while the cleanup runs.

Add the rule to the repo's contributor notes, so both people and AI-assisted edits follow it.

## Decision needed

1. Adopt the rule: yes or no.
2. Scope: new code only (B), or one directory per PR (C), or everything at once (A).
3. Whether a CI check should fail on history words in comments. (Recommendation: a warning first, then a failure once the cleanup is done.)

## Build plan

1. Add the four rules to the contributor notes.
2. A small script that lists comment blocks longer than 6 lines, and history words, per directory. Run it to size the work.
3. Clean one directory per PR. Each PR only edits comments, and the test suite must pass unchanged.
4. Once the largest directories are done, turn the check into a CI warning, and later into a failure.

## Acceptance criteria

- No comment block over 6 lines outside module headers.
- No history words in comments.
- Every diff in the cleanup is comment-only, and the tests pass without changes.
