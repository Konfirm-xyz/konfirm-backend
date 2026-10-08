use rust_decimal::Decimal;

// Decides whether an observed on-chain payment matches the link it was made
// against. Kept pure (no I/O) so every rule is unit-tested below without a
// database or Horizon. A payment that fails a rule is recorded as 'held'
// with a reason, never silently 'paid' — the merchant's dashboard and
// totals should only count money that matches what was actually asked for.

/// What the session's link said should be paid. Loaded by
/// `Store::link_expectation`, one row per reserved session.
#[derive(Debug, Clone)]
pub struct LinkExpectation {
    /// `None` for a pay-what-you-want link. The API refuses those today, so
    /// a payment against one can't be validated and is held for review.
    pub amount: Option<Decimal>,
    /// 'USDC' | 'EURC' | 'XLM' — the same set `links.currency` allows.
    pub currency: String,
    pub active: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Verdict {
    pub status: &'static str,
    pub flag_reason: Option<&'static str>,
}

impl Verdict {
    fn held(reason: &'static str) -> Self {
        Verdict { status: "held", flag_reason: Some(reason) }
    }
    fn paid() -> Self {
        Verdict { status: "paid", flag_reason: None }
    }
}

/// The issuer a given currency must have on-chain, or `None` for native XLM.
/// Returns `Err` for a currency this function doesn't know, so an unknown
/// asset is held rather than trusted.
fn expected_issuer(currency: &str) -> Result<Option<String>, ()> {
    match currency {
        "XLM" => Ok(None),
        "USDC" => Ok(Some(crate::usdc_issuer())),
        "EURC" => Ok(Some(crate::eurc_issuer())),
        _ => Err(()),
    }
}

/// `paid_issuer` is what Horizon reported for the observed payment's asset.
/// Checking the code alone is not enough: anyone can issue an asset named
/// "USDC", so the issuer has to match too.
///
/// A missing fee leg is not a reason to hold. The merchant was paid the link
/// amount, and the fee is recorded as owed (`fee_status = 'owed'`), to be
/// cleared by a merchant-signed settlement (docs/design/qr-fee-collection.md).
pub fn assess(
    link: Option<&LinkExpectation>,
    paid_amount: Decimal,
    paid_asset_code: &str,
    paid_issuer: Option<&str>,
) -> Verdict {
    let Some(link) = link else {
        return Verdict::held("no_session");
    };
    if !link.active {
        return Verdict::held("link_inactive");
    }
    let Some(expected_amount) = link.amount else {
        return Verdict::held("no_fixed_amount");
    };
    if paid_asset_code != link.currency {
        return Verdict::held("asset_mismatch");
    }
    match expected_issuer(&link.currency) {
        Ok(expected) if expected.as_deref() == paid_issuer => {}
        Ok(_) => return Verdict::held("issuer_mismatch"),
        Err(()) => return Verdict::held("asset_mismatch"),
    }
    if paid_amount != expected_amount {
        return Verdict::held("amount_mismatch");
    }
    Verdict::paid()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn d(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    fn link(amount: Option<&str>, currency: &str, active: bool) -> LinkExpectation {
        LinkExpectation {
            amount: amount.map(d),
            currency: currency.to_string(),
            active,
        }
    }

    fn usdc() -> Option<String> {
        Some(crate::usdc_issuer())
    }
    fn eurc() -> Option<String> {
        Some(crate::eurc_issuer())
    }

    #[test]
    fn exact_usdc_payment_is_paid() {
        let l = link(Some("10.0000000"), "USDC", true);
        assert_eq!(assess(Some(&l), d("10"), "USDC", usdc().as_deref()), Verdict::paid());
    }

    #[test]
    fn underpayment_is_held_not_paid() {
        let l = link(Some("100"), "USDC", true);
        assert_eq!(
            assess(Some(&l), d("0.01"), "USDC", usdc().as_deref()),
            Verdict::held("amount_mismatch")
        );
    }

    #[test]
    fn overpayment_is_held_too() {
        let l = link(Some("100"), "USDC", true);
        assert_eq!(
            assess(Some(&l), d("100.5"), "USDC", usdc().as_deref()),
            Verdict::held("amount_mismatch")
        );
    }

    #[test]
    fn payment_without_a_session_is_held() {
        assert_eq!(assess(None, d("5"), "USDC", usdc().as_deref()), Verdict::held("no_session"));
    }

    #[test]
    fn counterfeit_usdc_from_a_different_issuer_is_held() {
        let l = link(Some("10"), "USDC", true);
        assert_eq!(
            assess(Some(&l), d("10"), "USDC", Some("GFAKEISSUER")),
            Verdict::held("issuer_mismatch")
        );
    }

    #[test]
    fn native_xlm_payment_must_have_no_issuer() {
        let l = link(Some("10"), "XLM", true);
        assert_eq!(assess(Some(&l), d("10"), "XLM", None), Verdict::paid());
        assert_eq!(
            assess(Some(&l), d("10"), "XLM", usdc().as_deref()),
            Verdict::held("issuer_mismatch")
        );
    }

    #[test]
    fn paying_in_a_different_asset_than_the_link_is_held() {
        let l = link(Some("10"), "USDC", true);
        assert_eq!(
            assess(Some(&l), d("10"), "EURC", eurc().as_deref()),
            Verdict::held("asset_mismatch")
        );
    }

    #[test]
    fn unknown_currency_on_the_link_is_held() {
        let l = link(Some("10"), "BTC", true);
        assert_eq!(
            assess(Some(&l), d("10"), "BTC", Some("GANY")),
            Verdict::held("asset_mismatch")
        );
    }

    #[test]
    fn inactive_link_is_held() {
        let l = link(Some("10"), "USDC", false);
        assert_eq!(assess(Some(&l), d("10"), "USDC", usdc().as_deref()), Verdict::held("link_inactive"));
    }

    #[test]
    fn pay_what_you_want_link_is_held_because_it_cannot_be_checked() {
        let l = link(None, "USDC", true);
        assert_eq!(
            assess(Some(&l), d("3"), "USDC", usdc().as_deref()),
            Verdict::held("no_fixed_amount")
        );
    }

    #[test]
    fn missing_fee_leg_does_not_hold_the_payment() {
        // The merchant was paid the link amount. The fee is owed separately.
        let l = link(Some("10"), "USDC", true);
        assert_eq!(assess(Some(&l), d("10"), "USDC", usdc().as_deref()), Verdict::paid());
    }

    #[test]
    fn amount_check_happens_on_raw_asset_units_not_usd() {
        // An XLM link is priced in XLM. A raw 10 XLM payment matches even
        // though its USD-converted value would differ.
        let l = link(Some("10"), "XLM", true);
        assert_eq!(assess(Some(&l), d("10.0000000"), "XLM", None), Verdict::paid());
    }
}
