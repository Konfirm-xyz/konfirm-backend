-- Persistent investigation/notes thread on a payment (issue #34).
--
-- The existing admin_actions audit log captures one-shot status-change
-- reasons, but an admin who needs to leave context on a held or disputed
-- payment without changing its status — or who wants to build a running
-- thread of findings over time — had no place to write that. This table
-- is that place.
--
-- Design decisions:
--   - admin_id FK keeps each note attributed to a real admin row; ON DELETE
--     SET NULL so a deprovisioned admin's notes stay (the note text is the
--     record, not the author identity).
--   - No soft-delete: notes are an audit record, not a user message. If a
--     note needs to be retracted an admin can append a correction note. Hard
--     deletes are available as a migration (add is_deleted) if the product
--     needs that later.
--   - No upper bound on body length beyond Postgres's TEXT. A real content
--     moderation boundary is enforced at the API layer (Zod schema) rather
--     than here — the DB shouldn't be the place that truncates an
--     investigation note mid-sentence.
CREATE TABLE IF NOT EXISTS payment_notes (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id  UUID        NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    admin_id    UUID        REFERENCES admins(id) ON DELETE SET NULL,
    body        TEXT        NOT NULL CHECK (char_length(body) >= 1),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast thread load for a single payment (the only query shape this feature uses).
CREATE INDEX IF NOT EXISTS payment_notes_payment_id_idx
    ON payment_notes (payment_id, created_at);
