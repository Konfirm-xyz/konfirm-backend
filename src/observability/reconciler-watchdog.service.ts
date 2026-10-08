import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { pool } from '../db/pool';

// How long the reconciler can go without moving its cursor before we call it
// stalled. Real payments aren't visible on the dashboard while it's stalled
// (docs/RUNBOOK.md §4), so this is the one failure that makes money look like
// it never arrived.
export const RECONCILER_STALL_MINUTES = 10;

// The reconciler writes its cursor on every processed op, so an idle merchant
// still moves it only on new ops. A stale cursor alone isn't proof of a fault
// when nobody is paying, so this only fires when there is at least one active
// merchant to watch.
@Injectable()
export class ReconcilerWatchdogService {
  private readonly logger = new Logger(ReconcilerWatchdogService.name);

  @Cron('*/2 * * * *')
  async check(): Promise<{ stalled: boolean; ageMinutes: number | null }> {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM merchants WHERE status = 'active' AND stellar_base_address IS NOT NULL) AS active_merchants,
         (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at))) / 60 FROM reconciler_state) AS age_minutes`,
    );
    const activeMerchants: number = rows[0].active_merchants;
    const ageMinutes: number | null = rows[0].age_minutes === null ? null : Number(rows[0].age_minutes);

    if (activeMerchants === 0 || ageMinutes === null) {
      return { stalled: false, ageMinutes };
    }
    const stalled = ageMinutes > RECONCILER_STALL_MINUTES;
    if (stalled) {
      this.logger.error(
        `reconciler looks stalled: cursor last moved ${ageMinutes.toFixed(1)} min ago with ${activeMerchants} active merchant(s) — payments may not be showing up (see docs/RUNBOOK.md §4)`,
      );
    }
    return { stalled, ageMinutes };
  }
}
