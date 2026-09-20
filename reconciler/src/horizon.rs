use anyhow::{Context, Result};
use rust_decimal::Decimal;
use serde::Deserialize;
use std::str::FromStr;

// The /payments endpoint is misleadingly named — it actually returns every
// operation type that can move an asset (payment, create_account,
// path_payment_*, etc.), and each type carries a different field set.
// create_account in particular has no asset_type/from/to at all. Everything
// past the four fields every operation shares must be optional, or a single
// non-payment record in the page throws out the whole batch.
// Requested via `join=transactions` so each operation record embeds its
// enclosing transaction — that's where the MEMO_ID carrying the link
// session id lives now. Session routing moved off muxed (M...) destination
// addresses because Freighter's wallet extension has open bugs decoding
// muxed accounts in its own sign-confirmation UI (stellar/freighter#2841,
// #2856, #2863); a plain destination + memo is universally supported.
#[derive(Debug, Deserialize, Clone)]
pub struct EmbeddedTransaction {
    pub memo: Option<String>,
    pub memo_type: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct PaymentOp {
    pub id: String,
    pub paging_token: String,
    #[serde(rename = "type")]
    pub op_type: String,
    pub transaction_hash: String,
    pub asset_type: Option<String>,
    pub asset_code: Option<String>,
    pub asset_issuer: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub amount: Option<String>,
    // Still present for the non-wallet harness path (scripts/testnet-harness/pay.js),
    // which signs directly against a muxed destination without going through
    // Freighter — that path never hit the wallet bug, so it's left as a
    // fallback rather than removed.
    pub to_muxed: Option<String>,
    pub to_muxed_id: Option<String>,
    pub transaction: Option<EmbeddedTransaction>,
}

#[derive(Debug, Deserialize)]
struct Embedded {
    records: Vec<PaymentOp>,
}

#[derive(Debug, Deserialize)]
struct PaymentsResponse {
    #[serde(rename = "_embedded")]
    embedded: Embedded,
}

pub struct HorizonClient {
    base_url: String,
    http: reqwest::Client,
}

// reqwest::Client::new() has no timeout at all by default — a stalled
// connection to Horizon would hang this call (and the whole reconciler
// loop behind it) indefinitely rather than failing fast.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const MAX_ATTEMPTS: u32 = 3;

impl HorizonClient {
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            http: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .expect("failed to build Horizon HTTP client"),
        }
    }

    // Retries a transient failure (timeout, connection reset, a 5xx from
    // Horizon) with backoff; a genuine 4xx means the request itself is
    // wrong and retrying it three times wouldn't change that, so those
    // still surface immediately via the caller's own `error_for_status()`.
    async fn get_with_retry(&self, url: &str) -> Result<reqwest::Response> {
        let mut last_err = None;
        for attempt in 0..MAX_ATTEMPTS {
            match self.http.get(url).header("Accept", "application/json").send().await {
                Ok(resp) if resp.status().is_server_error() => {
                    last_err = Some(anyhow::anyhow!("Horizon returned {}", resp.status()));
                }
                Ok(resp) => return Ok(resp),
                Err(e) => last_err = Some(e.into()),
            }
            if attempt + 1 < MAX_ATTEMPTS {
                let backoff = std::time::Duration::from_millis(300 * 2u64.pow(attempt));
                tracing::warn!(attempt, url, "Horizon request failed, retrying after backoff");
                tokio::time::sleep(backoff).await;
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("Horizon request failed with no captured error")))
    }

    pub async fn payments_since(&self, account: &str, cursor: &str, limit: u32) -> Result<Vec<PaymentOp>> {
        let url = format!(
            "{}/accounts/{}/payments?cursor={}&order=asc&limit={}&join=transactions",
            self.base_url, account, cursor, limit
        );
        let resp = self
            .get_with_retry(&url)
            .await
            .context("horizon request failed")?
            .error_for_status()
            .context("horizon returned an error status")?
            .json::<PaymentsResponse>()
            .await
            .context("failed to parse horizon payments response")?;
        Ok(resp.embedded.records)
    }

    /// Fetches every operation in a single transaction, to find the
    /// sibling fee-collection leg of an already-matched checkout payment —
    /// the two legs share a transaction (submitted atomically, one payer
    /// signature) but the fee leg never touches the merchant's own
    /// address, so it never appears in payments_since's per-account feed
    /// at all. Reuses PaymentOp/PaymentsResponse since /operations returns
    /// the same record shape as /accounts/{id}/payments.
    pub async fn operations_for_transaction(&self, tx_hash: &str) -> Result<Vec<PaymentOp>> {
        let url = format!("{}/transactions/{}/operations?join=transactions", self.base_url, tx_hash);
        let resp = self
            .get_with_retry(&url)
            .await
            .context("horizon operations-for-transaction request failed")?
            .error_for_status()
            .context("horizon returned an error status for operations-for-transaction")?
            .json::<PaymentsResponse>()
            .await
            .context("failed to parse horizon operations-for-transaction response")?;
        Ok(resp.embedded.records)
    }

    /// Resolves the special 'now' cursor to the account's current latest
    /// paging_token, so the reconciler only ever sees payments that land
    /// *after* it started — never from an arbitrary hardcoded value, and
    /// never from true zero on an account with real history.
    pub async fn resolve_now_cursor(&self, account: &str) -> Result<String> {
        let url = format!(
            "{}/accounts/{}/payments?order=desc&limit=1",
            self.base_url, account
        );
        let resp = self
            .get_with_retry(&url)
            .await
            .context("horizon request failed while resolving now-cursor")?
            .error_for_status()
            .context("horizon returned an error status while resolving now-cursor")?
            .json::<PaymentsResponse>()
            .await
            .context("failed to parse horizon response while resolving now-cursor")?;
        Ok(resp
            .embedded
            .records
            .first()
            .map(|r| r.paging_token.clone())
            .unwrap_or_else(|| "0".to_string()))
    }

    /// Current XLM→USDC reference rate (USDC per 1 XLM), sourced from
    /// Stellar's own order book rather than a new external price API — the
    /// reconciler already depends on Horizon for everything else, so this
    /// adds zero new dependency class. Uses the midpoint of the best bid and
    /// best ask (the standard "mark price" convention most systems display
    /// as the current rate), not a single side of the book. This is a
    /// current-moment rate, not the rate at the exact ledger the payment
    /// landed on — Horizon's order book has no historical/point-in-time
    /// query, and the reconciler's own poll lag (seconds, not minutes)
    /// makes that gap immaterial for accounting purposes; it would matter
    /// for anything latency-sensitive like arbitrage, which this isn't.
    pub async fn xlm_usdc_rate(&self, usdc_issuer: &str) -> Result<Decimal> {
        self.order_book_usdc_rate("selling_asset_type=native", usdc_issuer, "XLM")
            .await
    }

    /// Same reasoning and same "current-moment mid, not point-in-time" caveat
    /// as xlm_usdc_rate — EURC is a real, live checkout currency
    /// (`links.currency`'s own CHECK constraint already allowed it before
    /// this had an actual conversion), and EUR/USD moves enough (a few
    /// percent a year, sometimes more) that treating it as 1:1 would repeat
    /// exactly the silent-wrong-dollar-figure bug already found and fixed
    /// for XLM.
    pub async fn eurc_usdc_rate(&self, eurc_issuer: &str, usdc_issuer: &str) -> Result<Decimal> {
        let selling = format!(
            "selling_asset_type=credit_alphanum4&selling_asset_code=EURC&selling_asset_issuer={}",
            eurc_issuer
        );
        self.order_book_usdc_rate(&selling, usdc_issuer, "EURC").await
    }

    async fn order_book_usdc_rate(&self, selling_query: &str, usdc_issuer: &str, label: &str) -> Result<Decimal> {
        let url = format!(
            "{}/order_book?{}&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer={}",
            self.base_url, selling_query, usdc_issuer
        );
        let resp = self
            .get_with_retry(&url)
            .await
            .context("horizon order_book request failed")?
            .error_for_status()
            .context("horizon returned an error status for order_book")?
            .json::<OrderBookResponse>()
            .await
            .context("failed to parse horizon order_book response")?;

        let best_bid = resp.bids.first().map(|l| Decimal::from_str(&l.price)).transpose()?;
        let best_ask = resp.asks.first().map(|l| Decimal::from_str(&l.price)).transpose()?;
        match (best_bid, best_ask) {
            (Some(bid), Some(ask)) => Ok((bid + ask) / Decimal::from(2)),
            (Some(bid), None) => Ok(bid),
            (None, Some(ask)) => Ok(ask),
            (None, None) => anyhow::bail!("{label}/USDC order book is empty on both sides — no rate available"),
        }
    }
}

#[derive(Debug, Deserialize)]
struct OrderBookLevel {
    price: String,
}

#[derive(Debug, Deserialize)]
struct OrderBookResponse {
    bids: Vec<OrderBookLevel>,
    asks: Vec<OrderBookLevel>,
}

#[cfg(test)]
mod test {
    use super::*;

    const USDC_TESTNET_ISSUER: &str = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    const EURC_TESTNET_ISSUER: &str = "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";

    // Against the real, live testnet order book, not a mock — confirmed
    // manually first (curl'd the same endpoint, saw a real non-empty book,
    // best bid 0.273 at the time this was written) before trusting this
    // assertion range. XLM has never traded anywhere near $1000, so this
    // bound is generous against normal price movement or testnet-specific
    // liquidity thinness, while still catching a genuinely broken parse
    // (e.g. an empty-book error, or a sign/decimal-place bug producing 0 or
    // something absurd).
    #[tokio::test]
    async fn xlm_usdc_rate_returns_a_real_positive_rate_from_live_testnet() {
        let client = HorizonClient::new("https://horizon-testnet.stellar.org");
        let rate = client
            .xlm_usdc_rate(USDC_TESTNET_ISSUER)
            .await
            .expect("live testnet order_book request should succeed");
        assert!(rate > Decimal::from(0), "rate should be positive, got {rate}");
        assert!(rate < Decimal::from(1000), "rate should be well under $1000/XLM, got {rate}");
    }

    // Same real-live-book standard as the XLM test above — confirmed
    // manually first (curl'd the same endpoint, saw a real one-sided book,
    // best ask 1.16 at the time this was written; testnet EURC/USDC
    // liquidity is thin, hence the wide bound below rather than a tight
    // EUR/USD-realistic one).
    #[tokio::test]
    async fn eurc_usdc_rate_returns_a_real_positive_rate_from_live_testnet() {
        let client = HorizonClient::new("https://horizon-testnet.stellar.org");
        let rate = client
            .eurc_usdc_rate(EURC_TESTNET_ISSUER, USDC_TESTNET_ISSUER)
            .await
            .expect("live testnet order_book request should succeed");
        assert!(rate > Decimal::from(0), "rate should be positive, got {rate}");
        assert!(rate < Decimal::from(10), "rate should be well under $10/EURC, got {rate}");
    }

    // A real, permanent testnet transaction — a fee-split checkout
    // transaction built by prepareTx and submitted for real during this
    // feature's own end-to-end verification (2 payment ops: 5 XLM to the
    // merchant, 0.005 XLM to the platform fee address). Testnet
    // transactions don't expire, so this is a stable fixture, same
    // reasoning as the channel netting engine's onchain_channel_id=1.
    #[tokio::test]
    async fn operations_for_transaction_returns_both_legs_of_a_real_fee_split_payment() {
        let client = HorizonClient::new("https://horizon-testnet.stellar.org");
        let ops = client
            .operations_for_transaction("0a8147370ed3b44ee86af0cd4e048b2d7c763b5911dd63039ee13fd5c207a7d2")
            .await
            .expect("live testnet operations request should succeed");
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].amount.as_deref(), Some("5.0000000"));
        assert_eq!(ops[1].amount.as_deref(), Some("0.0050000"));
        assert_eq!(ops[1].to.as_deref(), Some("GBJG2IGPXJ673TMTQMMJCSMITNSLVTIJ62MRSHCTQTTGNLV75TFR5PHY"));
    }
}
