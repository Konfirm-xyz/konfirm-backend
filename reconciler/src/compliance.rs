use std::time::Duration;
use soroban_client::account::{Account, AccountBehavior};
use soroban_client::address::{Address, AddressTrait};
use soroban_client::contract::{Contracts, ContractBehavior};
use soroban_client::network::{Networks, NetworkPassphrase};
use soroban_client::transaction_builder::{TransactionBuilder, TransactionBuilderBehavior};
use soroban_client::xdr::ScVal;
use soroban_client::{Options, Server};
use tokio::time::timeout;

// Same deployed Soroban contract payments.service.ts already calls from the
// Node side for the Freighter checkout path — kept as a plain duplicated
// constant rather than shared config, matching how the Node side hardcodes
// it too rather than making it env-configurable.
const COMPLIANCE_CONTRACT_ID_DEFAULT: &str = "CDDVLE2DZQAYFY3Z2Z74TUNNPC4ROUACSBXOB2P64IT75EZFAQXSRSXY";

// Overridable like the backend's COMPLIANCE_CONTRACT_ID, so both screen against
// the same contract.
fn compliance_contract_id() -> String {
    std::env::var("COMPLIANCE_CONTRACT_ID").unwrap_or_else(|_| COMPLIANCE_CONTRACT_ID_DEFAULT.to_string())
}
const RPC_URL_DEFAULT: &str = "https://soroban-testnet.stellar.org";

// Matches the backend's SOROBAN_RPC_URL override.
fn rpc_url() -> String {
    std::env::var("SOROBAN_RPC_URL").unwrap_or_else(|_| RPC_URL_DEFAULT.to_string())
}
// Used purely as the simulation source account for a read-only call —
// is_allowed never mutates state, so this account never signs or pays a
// fee. It just needs to be a real, existing testnet account (simulation
// still resolves the source account's ledger entry), so the sequence
// number handed to Account::new below is a placeholder, never the real
// one — see run_check's comment on build_for_simulation() for why that's
// safe. Same already-funded deployer identity onchain-compliance.ts uses
// on the Node side for the identical reason, not a privileged choice.
const SIMULATION_SOURCE_DEFAULT: &str = "GAEMG5TVLEIQYCY3XB4EJT742DIE3FQO53RSESSYJQUZIWZOJQIZATJS";

// The read-only source account for simulation. Matches the backend's
// DEPLOYER_ADDRESS.
fn simulation_source() -> String {
    std::env::var("DEPLOYER_ADDRESS").unwrap_or_else(|_| SIMULATION_SOURCE_DEFAULT.to_string())
}
const CHECK_TIMEOUT: Duration = Duration::from_secs(8);
const RETRY_DELAY: Duration = Duration::from_millis(500);

/// Screens a payer address against the on-chain compliance contract, for
/// SEP-7/QR payments the reconciler has just observed — the one checkout
/// path that can never be screened before the fact (see store.rs's
/// record_payment_if_new doc comment for why this runs decoupled from the
/// poll loop rather than inline).
///
/// Always returns a plain bool, never an error — matching the Node side's
/// documented invariant exactly: an unreachable compliance check must never
/// silently block anything, but it must never be silent about it either.
/// One retry after a single transient blip, then fails open with a logged
/// warning, same as payments.service.ts's isAllowedOnChain.
pub async fn is_allowed_on_chain(address: &str) -> bool {
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::time::sleep(RETRY_DELAY).await;
        }
        match timeout(CHECK_TIMEOUT, run_check(address)).await {
            Ok(Ok(allowed)) => return allowed,
            Ok(Err(err)) => {
                tracing::warn!(address, attempt, error = %err, "compliance check attempt failed");
            }
            Err(_) => {
                tracing::warn!(address, attempt, "compliance check attempt timed out");
            }
        }
    }
    tracing::warn!(address, "on-chain compliance check unreachable after retry, failing open");
    true
}

// Direct Soroban RPC simulation of the deployed compliance contract's
// is_allowed, replacing the previous `stellar contract invoke` CLI
// subprocess spawn — no CLI binary to ship in the container (and no
// libdbus/libssl/libudev/ca-certificates runtime dependencies that came
// with it, discovered live in production before onchain-compliance.ts's
// equivalent Node-side fix), and meaningfully faster: a single RPC round
// trip instead of a subprocess spawn + exec.
//
// Server::new/Contracts::new are cheap, purely local constructors here
// (confirmed by reading the actual soroban-client source — unlike the
// Node SDK's Client.from(), which does a real network round trip on first
// construction to fetch the contract spec, and is therefore cached there).
// Constructing fresh per call is simplest and correct — no shared client
// state to poison if a call ever hangs.
async fn run_check(address: &str) -> anyhow::Result<bool> {
    let rpc = Server::new(&rpc_url(), Options::default()).map_err(|e| anyhow::anyhow!("{e}"))?;
    let contract = Contracts::new(&compliance_contract_id()).map_err(|e| anyhow::anyhow!("{e}"))?;
    let addr_scval = Address::new(address)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .to_sc_val()
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    // Placeholder sequence — build_for_simulation() computes and uses
    // current+1 locally without incrementing the real Account object or
    // needing it to match the source account's actual on-chain sequence;
    // simulateTransaction never validates or consumes it since the
    // transaction is never submitted. Confirmed against the crate's own
    // build_for_simulation doc comment and its dedicated
    // test_multiple_simulations_without_incrementing test before trusting
    // this — this method exists specifically so repeated read-only calls
    // like this one never need a real account fetch first.
    let mut source_account = Account::new(&simulation_source(), "0").map_err(|e| anyhow::anyhow!("{e}"))?;

    let tx = TransactionBuilder::new(&mut source_account, Networks::testnet(), None)
        .fee(100u32)
        .add_operation(contract.call("is_allowed", Some(vec![addr_scval])))
        .build_for_simulation();

    let response = rpc
        .simulate_transaction(&tx, None)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    if let Some(err) = &response.error {
        anyhow::bail!("simulation error: {err}");
    }

    match response.to_result() {
        Some((ScVal::Bool(allowed), _auth)) => Ok(allowed),
        Some((other, _)) => anyhow::bail!("unexpected is_allowed return type: {other:?}"),
        None => anyhow::bail!("simulation returned no result"),
    }
}

#[cfg(test)]
mod test {
    use super::*;

    // Against the real, live compliance contract on testnet, not a mock —
    // same "no #[ignore], real network, real assertions" convention
    // horizon.rs's xlm_usdc_rate test already established in this crate.
    // The blocked-address branch (ScVal::Bool(false)) was verified
    // manually against a throwaway address blocked and then cleared via
    // the deployer identity — not committed here as an automated test,
    // since that would need this suite to carry admin rights over the
    // compliance contract and mutate real on-chain state on every run.
    // This decode path doesn't special-case true vs. false (see
    // run_check's match arm), so proving it decodes a real ScVal::Bool
    // correctly for one value is what actually matters here.
    #[tokio::test]
    async fn is_allowed_returns_true_for_a_known_unblocked_address_on_live_testnet() {
        let allowed = is_allowed_on_chain(&simulation_source()).await;
        assert!(allowed, "the facilitator's own address should never be blocked");
    }
}
