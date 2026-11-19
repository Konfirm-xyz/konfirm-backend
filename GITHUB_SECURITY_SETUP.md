# GitHub Security Configuration

This document describes the security settings that must be configured via the GitHub web UI to address security issues #114 and #117.

## Issue #114: Branch Protection on main

Branch protection prevents accidental or malicious modifications to the main branch by requiring:
- PR review before merge
- Required status checks (CI must pass)
- No force-push or deletion permissions

**Steps to enable:**

1. Navigate to Settings → Branches
2. Under "Branch protection rules", click "Add rule"
3. Enter branch name pattern: `main`
4. Enable the following options:
   - ✓ Require a pull request before merging
   - ✓ Require status checks to pass before merging
   - ✓ Require branches to be up to date before merging
   - ✓ Dismiss stale pull request approvals when new commits are pushed
   - ✓ Include administrators (recommended)
   - ✓ Restrict who can push to matching branches
   - ✓ Allow force pushes → None
   - ✓ Allow deletions → unchecked

5. Under "Status checks that must pass", select:
   - `test` (from the CI workflow)

6. Click "Create" to save the rule

**Verification:**
- Try to push directly to main → should be rejected
- Create a PR but don't wait for CI → merge button should be disabled
- Merge a PR after CI passes → should succeed

---

## Issue #117: Secret Scanning and Push Protection

Secret scanning automatically detects when credentials, API keys, or other secrets are committed to the repository. Push protection blocks the push before it reaches the repository.

**Steps to enable:**

1. Navigate to Settings → Security → Code security and analysis
2. Locate "Secret scanning" and click "Enable" (free for public repos)
3. Locate "Push protection for secret scanning" and click "Enable" (free for public repos)

**Optional: Secret scanning for custom patterns**

If you have custom secret patterns (e.g., internal API keys), you can also:
- Click "New pattern" under "Secret scanning for custom patterns"
- Define your pattern and what to look for

**Verification:**
- Create a test file with a fake AWS access key pattern
- Attempt to push → GitHub should block the push with a warning
- The push protection will alert that a secret pattern was detected

---

## Issue #113 & #118: Code Changes (Completed)

These issues have been fixed in the code:

### #113: Hardcoded Contract ID
- **Status**: ✓ Fixed
- **Change**: Removed hardcoded `PAYMENT_CONTRACT_ID` from `payment-attestation.service.ts`
- **Import**: Now imports `PAYMENT_CONTRACT_ID` from `stellar-network.ts`
- **Benefit**: Single source of truth for contract IDs with network-aware safety checks

### #118: GitHub Actions Security
- **Status**: ✓ Fixed  
- **Changes**:
  - Pinned `actions/checkout@v4.2.2` to commit SHA: `11bd71901bbe5b1630ceea73d27597364c9af683`
  - Pinned `actions/setup-node@v4.1.0` to commit SHA: `39370e3970a6d050c480ffad4ff0ed4d3fdee5af`
  - Actions are now immutable and auditable

**Verification**: the SHAs above are the real tag SHAs, fetched from GitHub's API, and match the pins in `.github/workflows/ci.yml`:

```
$ gh api repos/actions/checkout/git/refs/tags/v4.2.2 --jq '.object.sha'
11bd71901bbe5b1630ceea73d27597364c9af683
$ gh api repos/actions/setup-node/git/refs/tags/v4.1.0 --jq '.object.sha'
39370e3970a6d050c480ffad4ff0ed4d3fdee5af
```

To re-verify at any time, run the two commands above and compare against the `uses:` lines in `.github/workflows/ci.yml`.
  
**Note**: Repository-level GitHub Actions permissions (`allowed_actions: "selected"`) must still be configured via Settings → Code security and analysis → GitHub Actions → Permissions (see issue #118 for details).

---

## References

- [GitHub Branch Protection Documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule)
- [GitHub Secret Scanning Documentation](https://docs.github.com/en/code-security/secret-scanning/about-secret-scanning)
- [GitHub Actions Security Hardening](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
