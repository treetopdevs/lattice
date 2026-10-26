use serde_json::Value;
use treehouse_tauri_shell::catalog_eval::{artifact, chains, entries};
#[path = "support/catalog_peer.rs"]
mod catalog_peer;

#[test]
fn fresh_public_owner_decisions_pin_structural_links_and_exact_refusals() {
    check("ts", 21);
}

#[test]
fn fresh_beam_owner_decisions_pin_structural_links_and_exact_refusals() {
    check("beam", 29);
}

fn check(runtime: &str, count: usize) {
    let corpus: Value = serde_json::from_slice(&catalog_peer::output(
        runtime,
        "chains-produce",
        None,
        4 * 1024 * 1024,
    ))
    .unwrap();
    let bootstrap_artifact =
        artifact::parse(corpus["bootstrapCatalog"].as_str().unwrap().as_bytes()).unwrap();
    let histories = corpus["histories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|raw| {
            (
                raw["replica"].as_str().unwrap(),
                serde_json::to_vec(raw).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    let refs = histories
        .iter()
        .map(|(name, raw)| (*name, raw.as_slice()))
        .collect::<Vec<_>>();
    let bootstrap = entries::observe(&bootstrap_artifact, &refs).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), count);
    for case in cases {
        let catalogs = case["catalogs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|raw| artifact::parse(raw.as_str().unwrap().as_bytes()).unwrap())
            .collect::<Vec<_>>();
        let rotations = case["rotations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|raw| artifact::parse(raw.as_str().unwrap().as_bytes()).unwrap())
            .collect::<Vec<_>>();
        for reverse in [false, true] {
            // Borrow original sealed artifacts through a reordered index, then
            // parse the retained originals without rewriting any signing term.
            let mut catalogs = catalogs
                .iter()
                .map(|artifact| artifact::parse(artifact.bytes()).unwrap())
                .collect::<Vec<_>>();
            let mut rotations = rotations
                .iter()
                .map(|artifact| artifact::parse(artifact.bytes()).unwrap())
                .collect::<Vec<_>>();
            if reverse {
                catalogs.reverse();
                rotations.reverse();
            }
            let result = chains::observe(&bootstrap, &catalogs, &rotations);
            if case["result"]["kind"] == "reject" {
                let error = result.unwrap_err();
                assert_eq!(
                    error.reason,
                    case["result"]["reason"].as_str().unwrap(),
                    "{} reverse={reverse}",
                    case["name"]
                );
                assert_eq!(
                    serde_json::to_value(error.ids).unwrap(),
                    case["result"]["detail"]["ids"],
                    "{} reverse={reverse}",
                    case["name"]
                );
            } else {
                assert_eq!(
                    serde_json::to_value(result.unwrap()).unwrap(),
                    case["links"],
                    "{} reverse={reverse}",
                    case["name"]
                );
            }
        }
    }
}
