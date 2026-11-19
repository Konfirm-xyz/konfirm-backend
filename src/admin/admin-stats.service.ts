import { Injectable } from '@nestjs/common';
import { pool } from '../db/pool';
import { TERMINAL_WITHDRAWAL_STATUSES } from '../common/withdrawal-statuses';

// Reconciler cursor movement older than this is surfaced as stale so the
// Overview can warn instead of showing a bare timestamp.
const RECONCILER_STALE_AFTER_MINUTES = 15;

export interface AdminStats {
  merchants: { total: number; active: number; suspended: number; pending: number };
  payments: { today_count: number; today_net_usdc: string; last_7d_net_usdc: string };
  // Newest-last, one entry per day, always 7 entries — zero-filled for days
  // with no payments so the chart never has to guess about a gap.
  daily_volume: { date: string; net_usdc: string }[];
  compliance: { blocked_count: number };
  reconciler: { cursor: string | null; updated_at: string | null; stale: boolean; stale_after_minutes: number };
  withdrawals: { open_count: number };
  // Spend-guard halt state — the most severe operational signal. halted_at is
  // non-null while all facilitator signing is stopped.
  facilitator: { halted_at: string | null; halt_reason: string | null };
}

// Every number here is a real Postgres aggregate — nothing fabricated for
// the sake of a fuller-looking dashboard. If a metric can't be computed
// honestly from what's actually stored, it doesn't get a card.
@Injectable()
export class AdminStatsService {
  async get(): Promise<AdminStats> {
    // Both the daily_volume chart and the last_7d_net_usdc headline are derived
    // from the same 7 UTC-calendar-day buckets, so summing the bars always
    // equals the headline figure (not just at UTC midnight).
    const dayKeys: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      dayKeys.push(d.toISOString().slice(0, 10));
    }
    const windowStart = `${dayKeys[0]}T00:00:00Z`;

    const [merchantCounts, todayPayments, dailySeries, blockedCount, reconcilerState, openWithdrawals, facilitatorState] = await Promise.all([
      pool.query(`SELECT status, COUNT(*)::int AS count FROM merchants GROUP BY status`),
      pool.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(net_usdc), 0) AS net_usdc
         FROM payments WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      ),
      pool.query(
        `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                COALESCE(SUM(net_usdc), 0)::text AS net_usdc
         FROM payments
         WHERE created_at >= $1::timestamptz
         GROUP BY 1
         ORDER BY 1`,
        [windowStart],
      ),
      pool.query(`SELECT COUNT(*)::int AS count FROM blocked_addresses`),
      pool.query(`SELECT value, updated_at FROM reconciler_state WHERE key = 'cursor'`),
      pool.query(`SELECT COUNT(*)::int AS count FROM withdrawal_attempts WHERE last_status IS NULL OR last_status != ALL($1)`, [
        TERMINAL_WITHDRAWAL_STATUSES,
      ]),
      // facilitator_state is a generic key/value store (see
      // FacilitatorSpendGuardService's HALT_KEY/HALT_REASON_KEY) — there is
      // no single row with id=1 or halted_at/halt_reason columns.
      pool.query(`SELECT key, value FROM facilitator_state WHERE key IN ('halted_at', 'halt_reason')`),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of merchantCounts.rows) byStatus[row.status] = row.count;
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

    const byDay = new Map<string, string>();
    for (const row of dailySeries.rows) {
      byDay.set(row.day, row.net_usdc);
    }
    const daily_volume: { date: string; net_usdc: string }[] = dayKeys.map((date) => ({
      date,
      net_usdc: byDay.get(date) ?? '0',
    }));

    // Single source of truth: the headline figure is the sum of the same
    // 7 calendar-day buckets shown in the chart.
    const last7dNetUsdc = daily_volume.reduce((sum, bucket) => sum + Number(bucket.net_usdc), 0).toFixed(7);

    const reconcilerUpdatedAt: string | null = reconcilerState.rows[0]?.updated_at ?? null;
    const reconcilerStale =
      reconcilerUpdatedAt === null ||
      Date.now() - new Date(reconcilerUpdatedAt).getTime() > RECONCILER_STALE_AFTER_MINUTES * 60 * 1000;

    const facilitatorByKey: Record<string, string> = {};
    for (const row of facilitatorState.rows) facilitatorByKey[row.key] = row.value;

    return {
      merchants: {
        total,
        active: byStatus.active ?? 0,
        suspended: byStatus.suspended ?? 0,
        pending: byStatus.pending ?? 0,
      },
      payments: {
        today_count: todayPayments.rows[0].count,
        today_net_usdc: todayPayments.rows[0].net_usdc,
        last_7d_net_usdc: last7dNetUsdc,
      },
      daily_volume,
      compliance: { blocked_count: blockedCount.rows[0].count },
      reconciler: {
        cursor: reconcilerState.rows[0]?.value ?? null,
        updated_at: reconcilerUpdatedAt,
        stale: reconcilerStale,
        stale_after_minutes: RECONCILER_STALE_AFTER_MINUTES,
      },
      withdrawals: { open_count: openWithdrawals.rows[0].count },
      facilitator: {
        halted_at: facilitatorByKey.halted_at ?? null,
        halt_reason: facilitatorByKey.halt_reason ?? null,
      },
    };
  }
}
