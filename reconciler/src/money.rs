use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;

// The platform fee rule. Identical to src/common/money-rules.ts in the backend,
// and checked against the same golden vectors (money-rules/vectors.json).
// Amounts are exact in stroops (1e-7 of the asset), never floats.

const STROOPS: i128 = 10_000_000;

/// fee = floor(amount * bps / 10000) in stroops, raised to `floor` when positive.
/// A zero amount or zero rate charges nothing, even with a floor.
pub fn fee_stroops(amount: i128, bps: i32, floor: i128) -> i128 {
    if amount <= 0 || bps <= 0 {
        return 0;
    }
    let fee = amount * bps as i128 / 10_000;
    if fee < floor {
        floor
    } else {
        fee
    }
}

/// The owed fee for `amount` (asset units), with the floor in asset units.
pub fn owed_fee(amount: Decimal, bps: i32, floor: Decimal) -> Decimal {
    let amount_stroops = (amount * Decimal::from(STROOPS)).trunc().to_i128().unwrap_or(0);
    let floor_stroops = (floor * Decimal::from(STROOPS)).trunc().to_i128().unwrap_or(0);
    Decimal::from_i128_with_scale(fee_stroops(amount_stroops, bps, floor_stroops), 7)
}

/// The configured floor, in asset units. `PLATFORM_FEE_FLOOR` is read once per call
/// site. Unset or unparseable means no floor, which is today's behaviour.
pub fn configured_floor() -> Decimal {
    std::env::var("PLATFORM_FEE_FLOOR")
        .ok()
        .and_then(|v| v.parse::<Decimal>().ok())
        .unwrap_or(Decimal::ZERO)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    // The same vectors the backend's money-rules.spec.ts checks.
    #[test]
    fn golden_vectors_match_the_shared_file() {
        let file: serde_json::Value =
            serde_json::from_str(include_str!("../../money-rules/vectors.json")).unwrap();
        let vectors = file["vectors"].as_array().unwrap();
        assert!(!vectors.is_empty());
        for v in vectors {
            let amount = Decimal::from_str(v["amount"].as_str().unwrap()).unwrap();
            let bps = v["bps"].as_i64().unwrap() as i32;
            let floor = Decimal::from_str(v["floor"].as_str().unwrap()).unwrap();
            let want = Decimal::from_str(v["fee"].as_str().unwrap()).unwrap();
            let got = owed_fee(amount, bps, floor);
            assert_eq!(
                got.round_dp(7),
                want.round_dp(7),
                "vector {:?}",
                v["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn floor_is_zero_when_unconfigured() {
        std::env::remove_var("PLATFORM_FEE_FLOOR");
        assert_eq!(configured_floor(), Decimal::ZERO);
    }
}
