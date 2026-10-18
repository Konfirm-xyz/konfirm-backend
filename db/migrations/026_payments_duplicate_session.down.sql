-- Fails if any 'duplicate_session' rows exist, deliberately: restoring the
-- full unique index would mean deleting records of money that really moved,
-- which a migration must never do silently. Review and resolve those rows
-- by hand first.
DROP INDEX IF EXISTS payments_muxed_id_idx;
CREATE UNIQUE INDEX payments_muxed_id_idx ON payments(merchant_id, muxed_id);
