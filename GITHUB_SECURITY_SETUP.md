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
  - Pinned `actions/checkout@v4` to commit SHA: `11d59607cc989b6c31a8b6f5ee0e3ad0e9a6b297`
  - Pinned `actions/setup-node@v4` to commit SHA: `39370e3970a6d050c480ffad4ff0ed4d3fdee5cb`
  - Actions are now immutable and auditable
  
**Note**: Repository-level GitHub Actions permissions (`allowed_actions: "selected"`) must still be configured via Settings → Code security and analysis → GitHub Actions → Permissions (see issue #118 for details).

---

## Issue #283: Require SHA Pinning for Actions

GitHub can reject any workflow that references an action by tag or branch instead of a full-length commit SHA. This makes the pinning in #118 enforced rather than a convention.

**Steps to enable:**

1. Navigate to Settings → Actions → General
2. Under "Workflow permissions", enable **Require actions to be pinned to a full-length commit SHA**
3. Or apply it with the API:

   ```sh
   gh api -X PUT repos/Konfirm-xyz/konfirm-backend/actions/permissions \
     -f sha_pinning_required=true
   ```

The same value is declared in `.github/settings.yml` (`repository.sha_pinning_required: true`) so the Settings app keeps it applied.

**Verification:**

- `gh api repos/Konfirm-xyz/konfirm-backend/actions/permissions` → `"sha_pinning_required": true`
- Open a PR that changes a workflow step to `uses: actions/checkout@v4` → the workflow is rejected before merge
- Every `uses:` in `.github/workflows/` points at a 40-character commit SHA

---

## References

- [GitHub Branch Protection Documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule)
- [GitHub Secret Scanning Documentation](https://docs.github.com/en/code-security/secret-scanning/about-secret-scanning)
- [GitHub Actions Security Hardening](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
