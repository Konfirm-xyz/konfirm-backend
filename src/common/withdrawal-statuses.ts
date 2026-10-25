// Shared with admin-stats.service.ts and admin-withdrawal-attempts.service.ts
// (see #53 — this list was duplicated verbatim in both files). These are the
// SEP-24 anchor transaction statuses that will never change again once
// reached, so a row in that state is skipped on the next poll and excluded
// from "still open" counts.
export const TERMINAL_WITHDRAWAL_STATUSES = ['completed', 'error', 'expired', 'refunded'];
