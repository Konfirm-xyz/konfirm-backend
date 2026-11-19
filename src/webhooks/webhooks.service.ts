import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool';

// Merchant-configurable webhooks (issue #248).
//
// Two responsibilities, deliberately in one service because they share the
// signing format:
//   1. CRUD for a merchant's single webhook endpoint (URL + HMAC secret).
//   2. Enqueueing and delivering signed events on payment status transitions.
//
// Delivery is outbox-shaped: `enqueue` only writes a `webhook_deliveries` row
// (cheap, inside the caller's request), and `deliverDue` — called by the
// sweeper — does the HTTP work. A merchant's slow or dead endpoint therefore
// never blocks an admin status change or a reconciler write.

export type WebhookEvent = 'payment.paid' | 'payment.held' | 'payment.disputed';

const EVENT_FOR_STATUS: Record<string, WebhookEvent> = {
  paid: 'payment.paid',
  held: 'payment.held',
  disputed: 'payment.disputed',
};

// Retry schedule: 5 attempts over roughly an hour, then give up and leave the
// row 'failed' for a human to inspect. Webhooks are notifications, not the
// source of truth — the payment row is — so a permanently dead endpoint must
// not retry forever.
const MAX_ATTEMPTS = 5;
const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600];
const DELIVERY_TIMEOUT_MS = 10_000;
const BATCH_SIZE = 20;

export interface WebhookConfig {
  id: string;
  merchant_id: string;
  url: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface DueDelivery {
  id: string;
  merchant_id: string;
  event: WebhookEvent;
  payload: unknown;
  attempts: number;
  url: string;
  secret: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  // --- Configuration ---

  async get(merchantId: string): Promise<WebhookConfig | null> {
    const { rows } = await pool.query<WebhookConfig>(
      `SELECT id, merchant_id, url, enabled, created_at, updated_at
       FROM merchant_webhooks WHERE merchant_id = $1`,
      [merchantId],
    );
    return rows[0] ?? null;
  }

  // Upsert: a merchant has exactly one endpoint, so "configure" is idempotent
  // rather than a create-then-conflict dance. The secret is only ever
  // returned here, at write time, so the merchant can copy it into their own
  // verifier; reads never echo it back.
  async upsert(
    merchantId: string,
    input: { url: string; secret?: string; enabled?: boolean },
  ): Promise<WebhookConfig & { secret: string }> {
    const secret = input.secret ?? randomBytes(32).toString('hex');
    const { rows } = await pool.query<WebhookConfig & { secret: string }>(
      `INSERT INTO merchant_webhooks (merchant_id, url, secret, enabled)
       VALUES ($1, $2, $3, COALESCE($4, TRUE))
       ON CONFLICT (merchant_id) DO UPDATE
         SET url = EXCLUDED.url,
             secret = EXCLUDED.secret,
             enabled = EXCLUDED.enabled,
             updated_at = NOW()
       RETURNING id, merchant_id, url, secret, enabled, created_at, updated_at`,
      [merchantId, input.url, secret, input.enabled ?? null],
    );
    return rows[0];
  }

  async remove(merchantId: string): Promise<void> {
    const { rowCount } = await pool.query('DELETE FROM merchant_webhooks WHERE merchant_id = $1', [merchantId]);
    if (!rowCount) throw new NotFoundException('no webhook configured');
  }

  // --- Events ---

  // Called after a payment's status has actually changed. No-ops when the
  // merchant has no enabled endpoint, so the common case costs one indexed
  // lookup and nothing else.
  async enqueuePaymentEvent(paymentId: string, status: string): Promise<void> {
    const event = EVENT_FOR_STATUS[status];
    if (!event) return;

    const { rows } = await pool.query<{
      merchant_id: string;
      amount_usdc: string;
      asset_code: string;
      payer_address: string | null;
      tx_hash: string | null;
      created_at: Date;
    }>(
      `SELECT p.merchant_id, p.amount_usdc, p.asset_code, p.payer_address, p.tx_hash, p.created_at
       FROM payments p
       JOIN merchant_webhooks w ON w.merchant_id = p.merchant_id AND w.enabled
       WHERE p.id = $1`,
      [paymentId],
    );
    const payment = rows[0];
    if (!payment) return;

    const payload = {
      event,
      payment_id: paymentId,
      merchant_id: payment.merchant_id,
      status,
      amount_usdc: payment.amount_usdc,
      asset_code: payment.asset_code,
      payer_address: payment.payer_address,
      tx_hash: payment.tx_hash,
      created_at: payment.created_at,
    };

    await pool.query(
      `INSERT INTO webhook_deliveries (merchant_id, payment_id, event, payload)
       VALUES ($1, $2, $3, $4)`,
      [payment.merchant_id, paymentId, event, JSON.stringify(payload)],
    );
  }

  // --- Delivery ---

  // Drains due deliveries. Each row is claimed with a conditional UPDATE so
  // two api replicas sweeping at once can't both POST the same event.
  async deliverDue(): Promise<void> {
    const { rows } = await pool.query<DueDelivery>(
      `SELECT d.id, d.merchant_id, d.event, d.payload, d.attempts, w.url, w.secret
       FROM webhook_deliveries d
       JOIN merchant_webhooks w ON w.merchant_id = d.merchant_id AND w.enabled
       WHERE d.status = 'pending' AND d.next_attempt_at <= NOW()
       ORDER BY d.next_attempt_at ASC
       LIMIT $1`,
      [BATCH_SIZE],
    );

    for (const row of rows) {
      const claimed = await pool.query(
        `UPDATE webhook_deliveries SET attempts = attempts + 1
         WHERE id = $1 AND status = 'pending'
         RETURNING attempts`,
        [row.id],
      );
      if (!claimed.rowCount) continue;
      const attempts = claimed.rows[0].attempts as number;

      try {
        await this.post(row.url, row.secret, row.event, row.payload, row.id);
        await pool.query(
          `UPDATE webhook_deliveries SET status = 'delivered', delivered_at = NOW(), last_error = NULL
           WHERE id = $1`,
          [row.id],
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const exhausted = attempts >= MAX_ATTEMPTS;
        const delay = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
        await pool.query(
          `UPDATE webhook_deliveries
           SET status = $2, last_error = $3, next_attempt_at = NOW() + ($4 * INTERVAL '1 second')
           WHERE id = $1`,
          [row.id, exhausted ? 'failed' : 'pending', message.slice(0, 500), delay],
        );
        this.logger.warn(`webhook ${row.id} (${row.event}) attempt ${attempts} failed: ${message}`);
      }
    }
  }

  // Signature format: `t=<unix seconds>,v1=<hex hmac-sha256 of "t.body">`.
  // The timestamp is inside the signed string so a captured request can't be
  // replayed later with a fresh header — verifiers reject old `t` values.
  private async post(url: string, secret: string, event: WebhookEvent, payload: unknown, deliveryId: string): Promise<void> {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'konfirm-webhooks/1',
        'x-konfirm-event': event,
        'x-konfirm-delivery': deliveryId,
        'x-konfirm-signature': `t=${timestamp},v1=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`endpoint returned ${res.status}`);
  }
}

// Exported for the merchant-facing docs and for tests: the exact string a
// receiver must HMAC to verify a delivery.
export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifyWebhookSignature(secret: string, header: string, body: string, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhookPayload(secret, timestamp, body), 'hex');
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
