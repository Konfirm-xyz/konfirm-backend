import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { pool } from '../db/pool';

const HALT_KEY = 'halted_at';
const HALT_REASON_KEY = 'halt_reason';

export interface ParsedDailyCap {
  capUsdc: number;
  configError: string | null;
}

// A tunable ceiling, not a hardcoded guess -- how much daily exposure is
// acceptable is an operational/business call, not something to bake into
// code. Deliberately no fallback that silently disables the cap (an unset
// or malformed env var defaults to a conservative $0, meaning "not
// configured" and "misconfigured" both fail closed, consistent with
// everything else in this guard).
export function parseDailyCapUsdc(
  raw: string | undefined = process.env.FACILITATOR_DAILY_SPEND_CAP_USDC,
): ParsedDailyCap {
  if (raw === undefined || raw.trim() === '') {
    return { capUsdc: 0, configError: null };
  }
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || !/^\d+(\.\d+)?$/.test(trimmed)) {
    return {
      capUsdc: 0,
      configError: `FACILITATOR_DAILY_SPEND_CAP_USDC=${JSON.stringify(raw)} is not a valid non-negative number; failing closed to $0`,
    };
  }
  return { capUsdc: parsed, configError: null };
}

function dailyCapUsdc(): number {
  return parseDailyCapUsdc().capUsdc;
}

export class FacilitatorSpendCapExceeded extends Error {}
export class FacilitatorHalted extends Error {}

/**
 * Bounds the blast radius of a compromised *application* (not just a
 * leaked key) abusing its own legitimate KMS signing access -- a
 * different threat from what onchain-compliance.ts's isAllowedOnChain
 * defends against, which is deliberately why this fails closed where that
 * one fails open. If this can't determine today's spend (DB unreachable),
 * it refuses to sign rather than proceeding -- the opposite default,
 * because this exists specifically to bound financial risk, not to avoid
 * blocking a legitimate payment during an infra blip.
 *
 * A cap breach halts ALL further signing, not just the one over-cap
 * operation, until an admin explicitly resumes it (see
 * FacilitatorController's /admin/facilitator/resume) -- the threat model
 * here is "something is already wrong," so the safe default is a human
 * looking at it, not an automatic reset at midnight.
 */
@Injectable()
export class FacilitatorSpendGuardService implements OnModuleInit {
  private readonly logger = new Logger(FacilitatorSpendGuardService.name);

  onModuleInit(): void {
    const { configError } = parseDailyCapUsdc();
    if (configError) {
      this.logger.error(`facilitator spend guard misconfigured: ${configError}`);
    }
  }

  async checkAndRecordSpend(amountUsdc: number, operation: string, reference?: string): Promise<void> {
    let halted: { value: string } | undefined;
    let spentTodayRow: { total: string };
    try {
      const [haltResult, spendResult] = await Promise.all([
        pool.query<{ value: string }>('SELECT value FROM facilitator_state WHERE key = $1', [HALT_KEY]),
        pool.query<{ total: string }>(
          `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM facilitator_spend_log WHERE created_at >= date_trunc('day', NOW())`,
        ),
      ]);
      halted = haltResult.rows[0];
      spentTodayRow = spendResult.rows[0];
    } catch (err) {
      throw new Error(`facilitator spend guard: could not read spend state, refusing to sign (fail closed): ${err}`);
    }

    if (halted) {
      throw new FacilitatorHalted(
        `facilitator signing is halted (since ${halted.value}) pending manual review -- ` +
          'see GET /admin/facilitator/status, resume via POST /admin/facilitator/resume',
      );
    }

    const spentToday = Number(spentTodayRow.total);
    const { capUsdc: cap, configError } = parseDailyCapUsdc();
    if (configError !== null || !(spentToday + amountUsdc <= cap)) {
      const reasonDetail = configError ? ` (${configError})` : '';
      await this.halt(
        `daily cap exceeded: attempted $${amountUsdc} (${operation}${reference ? ` ${reference}` : ''}) ` +
          `with $${spentToday} already spent today against a $${cap} cap${reasonDetail}`,
      );
      throw new FacilitatorSpendCapExceeded(
        `signing this $${amountUsdc} ${operation} would exceed the daily cap of $${cap}${reasonDetail} ` +
          `($${spentToday} already spent today) -- halting further signing pending manual review`,
      );
    }

    await pool.query('INSERT INTO facilitator_spend_log (amount_usdc, operation, reference) VALUES ($1, $2, $3)', [
      amountUsdc,
      operation,
      reference ?? null,
    ]);
  }

  private async halt(reason: string): Promise<void> {
    this.logger.error(`HALTING facilitator signing: ${reason}`);
    await pool.query(
      `INSERT INTO facilitator_state (key, value) VALUES ($1, NOW()::text)
       ON CONFLICT (key) DO UPDATE SET value = NOW()::text, updated_at = NOW()`,
      [HALT_KEY],
    );
    await pool.query(
      `INSERT INTO facilitator_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [HALT_REASON_KEY, reason],
    );
  }

  async status(): Promise<{
    halted: boolean;
    haltedAt: string | null;
    haltReason: string | null;
    spentTodayUsdc: number;
    capUsdc: number;
    capConfigError: string | null;
  }> {
    const [haltedAt, reason, spend] = await Promise.all([
      pool.query<{ value: string }>('SELECT value FROM facilitator_state WHERE key = $1', [HALT_KEY]),
      pool.query<{ value: string }>('SELECT value FROM facilitator_state WHERE key = $1', [HALT_REASON_KEY]),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM facilitator_spend_log WHERE created_at >= date_trunc('day', NOW())`,
      ),
    ]);
    const { capUsdc, configError } = parseDailyCapUsdc();
    return {
      halted: haltedAt.rows.length > 0,
      haltedAt: haltedAt.rows[0]?.value ?? null,
      haltReason: reason.rows[0]?.value ?? null,
      spentTodayUsdc: Number(spend.rows[0].total),
      capUsdc,
      capConfigError: configError,
    };
  }

  /** Explicit admin action only -- see the module comment for why this
   * never clears itself. */
  async resume(): Promise<void> {
    await pool.query('DELETE FROM facilitator_state WHERE key IN ($1, $2)', [HALT_KEY, HALT_REASON_KEY]);
  }
}
