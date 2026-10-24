//! Plan 198 differential test: the shell's TypeScript validators and `preview.rs` read one table
//! (`route_alphabet.json`) and must give the same verdict on every generated case.
use serde::Deserialize;
use treehouse_tauri_shell::preview::{valid_realm_text, valid_route_url};

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../test/route_alphabet_cases.json"
));
const TABLE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../route_alphabet.json"
));

#[derive(Deserialize)]
struct Case {
    kind: String,
    value: String,
    valid: bool,
}

#[test]
fn host_alphabet_in_the_table_is_the_one_the_byte_check_implements() {
    // preview.rs checks host bytes by hand (no regex crate); a table change must not diverge silently.
    let table: serde_json::Value = serde_json::from_str(TABLE).unwrap();
    assert_eq!(
        table["routeUrl"]["hostAlphabet"].as_str(),
        Some("^[A-Za-z0-9._-]+$")
    );
}

#[test]
fn rust_and_typescript_agree_on_every_case() {
    let cases: Vec<Case> = serde_json::from_str(CASES).expect("cases file parses");
    for kind in ["realm", "url"] {
        let count = cases.iter().filter(|c| c.kind == kind).count();
        assert!(
            count >= 1000,
            "{kind} has {count} cases, need at least 1000"
        );
    }
    for case in &cases {
        let rust = match case.kind.as_str() {
            "realm" => valid_realm_text(&case.value),
            "url" => valid_route_url(&case.value),
            other => panic!("unknown case kind {other}"),
        };
        assert_eq!(
            rust,
            case.valid,
            "{} {:?}: rust says {rust}, typescript says {}",
            case.kind,
            case.value.escape_debug().to_string(),
            case.valid
        );
    }
}

// Row 232: the persisted-profile and route replica grammars (legacy OR bounded, Space or Thread) agree with the shell.
const REPLICA_CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../test/replica_grammar_cases.json"
));

#[derive(Deserialize)]
struct ReplicaCase {
    value: String,
    space: bool,
    thread: bool,
    note: String,
}

#[test]
fn rust_and_typescript_agree_on_every_replica_grammar_case() {
    use treehouse_tauri_shell::preview::{valid_profile_replica, valid_route_replica};
    let cases: Vec<ReplicaCase> = serde_json::from_str(REPLICA_CASES).expect("replica cases parse");
    assert!(cases.len() >= 50);
    for case in &cases {
        assert_eq!(valid_profile_replica(&case.value, "space"), case.space, "{}", case.note);
        assert_eq!(valid_profile_replica(&case.value, "thread"), case.thread, "{}", case.note);
        assert_eq!(valid_route_replica(&case.value), case.space || case.thread, "{}", case.note);
    }
}
