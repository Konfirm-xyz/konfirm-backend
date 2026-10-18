-- A second, well-formed payment to an already-used muxed address (a
-- double-send, a wallet retry, a deliberate top-up) is real money that has
-- already landed on-chain. The original full UNIQUE (merchant_id, muxed_id)
-- made the reconciler's INSERT fail with 23505 on it -- ON CONFLICT
-- (paging_token) only covers that one constraint -- and the error escaped
-- poll_once before the cursor advanced, wedging that merchant's reconciler
-- forever.
--
-- The intended behavior is recorded-and-flagged, never dropped: the
-- reconciler writes the extra payment as status 'held' with flag_reason
-- 'duplicate_session' (reconciler/src/store.rs, record_payment_if_new), so
-- it's visible to the merchant and an admin, but not counted as 'paid'
-- volume until someone reviews it. Uniqueness still holds for every other
-- row: there is at most one primary payment per session.
--
-- Same index name on purpose -- the reconciler recognises a violation of
-- this constraint by name.
DROP INDEX IF EXISTS payments_muxed_id_idx;
CREATE UNIQUE INDEX payments_muxed_id_idx ON payments(merchant_id, muxed_id)
    WHERE flag_reason IS DISTINCT FROM 'duplicate_session';
