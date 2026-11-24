-- Merchant-configurable webhooks (issue #248).
--
-- One endpoint per merchant for now: the acceptance criterion is "a merchant
-- can configure a webhook URL + secret", not a fan-out list. A UNIQUE
-- merchant_id keeps the upsert in WebhooksService simple and makes "the
-- merchant's webhook" a single row.
--
-- The secret is stored as-is (not hashed) because it has to be replayed into
-- an HMAC on every delivery — unlike a password, it is a shared signing key,
-- not something we only ever verify. It is never returned by the API.
CREATE TABLE IF NOT EXISTS merchant_webhooks (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID        NOT NULL UNIQUE REFERENCES merchants(id) ON DELETE CASCADE,
    url         TEXT        NOT NULL CHECK (url ~ '^https?://'),
    secret      TEXT        NOT NULL CHECK (length(secret) >= 16),
    enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Delivery log. Doubles as the outbox the retry sweeper drains: a row is
-- inserted 'pending' at transition time and flipped to 'delivered'/'failed'
-- once the HTTP call settles, so a crash mid-delivery is retried rather than
-- silently dropped.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id  UUID        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    payment_id   UUID        REFERENCES payments(id) ON DELETE SET NULL,
    event        TEXT        NOT NULL CHECK (event IN ('payment.paid', 'payment.held', 'payment.disputed')),
    payload      JSONB       NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts     INTEGER     NOT NULL DEFAULT 0,
    last_error   TEXT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
    ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_merchant
    ON webhook_deliveries (merchant_id, created_at DESC);
