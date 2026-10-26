//! Full public-owner requests for the native retained resolver workstream.
//! Native coverage here is the authenticated union stage, not a retained verdict.
//! Missing prerequisites fail; no saved result or shape-only fallback is used.
use serde_json::{json, Value};
use treehouse_tauri_shell::catalog_eval::histories::AuthenticatedHistories;
#[path = "support/catalog_peer.rs"]
mod catalog_peer;

#[test]
fn source_contract_and_native_union_cover_empty_pending_rotation_fork_and_recovery() {
    compare("resolver-produce", 11);
}

#[test]
fn source_contract_and_native_union_cover_historical_witness_replay_and_rehonor() {
    compare("witness-produce", 14);
}

fn compare(mode: &str, expected_count: usize) {
    let table: Value =
        serde_json::from_slice(&catalog_peer::output("ts", mode, None, 32 * 1024 * 1024)).unwrap();
    let cases = table["cases"].as_array().unwrap();
    assert_eq!(cases.len(), expected_count);
    let mut requests = Vec::with_capacity(expected_count * 2);
    let mut expected = Vec::with_capacity(expected_count * 2);
    for case in cases {
        let orders = case["orders"].as_array().unwrap();
        assert_eq!(orders.len(), 2, "{}", case["name"]);
        for (order, row) in orders.iter().enumerate() {
            let input = &row["input"];
            let name = format!("{}:{order}", case["name"].as_str().unwrap());
            requests.push(json!({"name":name,"input":input}));
            expected.push(row["decision"].clone());
        }
    }
    // The second actual owner receives these very requests in the same run.
    // A passing first-runtime comparison cannot hide owner disagreement.
    let beam: Value = serde_json::from_slice(&catalog_peer::output(
        "beam",
        "resolver-consume",
        Some(&json!({"cases":&requests})),
        32 * 1024 * 1024,
    ))
    .unwrap();
    let results = beam["results"].as_array().unwrap();
    assert_eq!(results.len(), expected_count * 2);
    for (index, row) in results.iter().enumerate() {
        assert_eq!(row["decision"], expected[index], "{}", row["name"]);
    }
    // Only compare the native union after both actual complete owners agree.
    // Rejected snapshots do not designate either supplied history list trusted.
    for (request, decision) in requests.iter().zip(expected.iter()) {
        if decision["kind"] == "reject" {
            continue;
        }
        let input = &request["input"];
        let union = AuthenticatedHistories::authenticate_union(
            &input["installed"]["histories"],
            &input["incoming"]["histories"],
        )
        .unwrap_or_else(|e| panic!("{}: {e:?}", request["name"]));
        let raw: Vec<_> = union
            .iter()
            .map(|(_, history)| history.raw().clone())
            .collect();
        assert_eq!(
            json!(raw),
            decision["next"]["histories"],
            "{}",
            request["name"]
        );
    }
}
