use treehouse_tauri_shell::catalog_eval::{
    artifact,
    canonical::{Term, MAX_BYTES},
};

#[test]
fn raw_profile_precedes_legacy_integer_normalization() {
    for raw in [
        r#"["int","0"]"#,
        r#"["int","1"]"#,
        r#"["int","9007199254740991"]"#,
    ] {
        assert!(Term::from_carrier(&serde_json::from_str(raw).unwrap()).is_ok());
        assert_eq!(
            artifact::parse(raw.as_bytes()).unwrap_err(),
            "malformed_catalog"
        );
    }
    for raw in [
        r#"["int",0]"#,
        r#"["int",9007199254740991]"#,
        r#"["int","9007199254740992"]"#,
        r#"["int","18446744073709551615"]"#,
    ] {
        assert!(artifact::parse(raw.as_bytes()).is_ok(), "{raw}");
    }
    for token in [
        "-0",
        "-1",
        "1.0",
        "1e0",
        "01",
        "9007199254740992",
        "18446744073709551615",
    ] {
        assert_eq!(
            artifact::parse(format!(r#"["int",{token}]"#).as_bytes()).unwrap_err(),
            "malformed_catalog"
        );
    }
    for token in ["18446744073709551616".to_owned(), "9".repeat(10000)] {
        assert_eq!(
            artifact::parse(format!(r#"["int","{token}"]"#).as_bytes()).unwrap_err(),
            "malformed_catalog"
        );
    }
}

#[test]
fn original_bytes_and_exact_artifact_limit_are_retained() {
    let mut raw = br#"["int",1]"#.to_vec();
    raw.resize(MAX_BYTES, b' ');
    let parsed = artifact::parse(&raw).unwrap();
    assert_eq!(parsed.bytes(), raw);
    assert_eq!(parsed.term(), &Term::Integer(1));
    raw.push(b' ');
    assert_eq!(artifact::parse(&raw).unwrap_err(), "control_history_limit");
    // Binary payload round-trip is separate from JSON quote/escape handling.
    let bytes = b"-0 1e0 1.0 \\\" 18446744073709551616";
    use base64::{engine::general_purpose::STANDARD, Engine};
    let json = serde_json::json!(["bin", STANDARD.encode(bytes)]).to_string();
    assert_eq!(
        artifact::parse(json.as_bytes()).unwrap().term(),
        &Term::Binary(bytes.to_vec())
    );
}

#[path = "support/catalog_peer.rs"]
mod catalog_peer;

#[test]
fn fresh_signed_source_artifacts_obey_the_same_public_admission_profile() {
    for runtime in ["ts", "beam"] {
        let raw = catalog_peer::output(runtime, "artifact-profile-produce", None, 4 * 1024 * 1024);
        let table: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        let cases = table["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 27);
        for case in cases {
            let source = &case["results"][0];
            assert_eq!(source["kind"], "reject");
            let json = case["json"].as_str().unwrap();
            assert_eq!(
                artifact::parse(json.as_bytes()).unwrap_err(),
                source["reason"].as_str().unwrap(),
                "{runtime}: {json:.100}"
            );
        }
        let foreign = table["foreign"].as_array().unwrap();
        assert_eq!(foreign.len(), 6);
        for case in foreign {
            assert_eq!(case["result"]["kind"], "reject");
            assert_eq!(case["result"]["reason"], "malformed_catalog");
            assert_eq!(
                artifact::parse(case["json"].as_str().unwrap().as_bytes()).unwrap_err(),
                "malformed_catalog"
            );
        }
        let controls = table["controls"].as_array().unwrap();
        assert_eq!(controls.len(), 2);
        for control in controls {
            assert_eq!(control["result"]["kind"], "propose");
            let json = control["json"].as_str().unwrap();
            let parsed = artifact::parse(json.as_bytes()).unwrap();
            assert_eq!(parsed.bytes(), json.as_bytes());
            assert_eq!(
                parsed.term(),
                &Term::from_carrier(&serde_json::from_str(json).unwrap()).unwrap()
            );
            let over = json.to_owned() + " ";
            assert_eq!(control["over"]["kind"], "reject");
            assert_eq!(
                artifact::parse(over.as_bytes()).unwrap_err(),
                control["over"]["reason"].as_str().unwrap()
            );
        }
    }
}

#[test]
fn quoted_json_content_does_not_hide_a_later_invalid_number() {
    let text = "\" -0 1.0 1e0 9007199254740992 \\";
    let value = serde_json::json!(["list", [["atom", text], ["atom", "int"], ["int", 1]]]);
    let raw = value.to_string();
    let parsed = artifact::parse(raw.as_bytes()).unwrap();
    assert_eq!(parsed.bytes(), raw.as_bytes());
    assert_eq!(
        parsed.term(),
        &Term::List(vec![
            Term::Atom(text.into()),
            Term::Atom("int".into()),
            Term::Integer(1)
        ])
    );
    let invalid = raw.replace(r#"["int",1]"#, r#"["int",1e0]"#);
    assert_ne!(invalid, raw);
    assert_eq!(
        artifact::parse(invalid.as_bytes()).unwrap_err(),
        "malformed_catalog"
    );
}

#[test]
fn flat_delegation_metadata_never_becomes_a_catalog_artifact() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    for epoch in [serde_json::json!(5), serde_json::json!("5")] {
        let term = serde_json::json!(["delegation",{"id":"","replica":"","issuer":STANDARD.encode([7;32]),"audience":STANDARD.encode([7;32]),"parent_id":null,"ops":["int","5"],"roles":[],"live":true,"sig":STANDARD.encode([9;64]),"expires_epoch":epoch}]);
        assert!(
            Term::from_carrier(&term).is_ok(),
            "legacy typed metadata stays supported"
        );
        assert_eq!(
            artifact::parse(term.to_string().as_bytes()).unwrap_err(),
            "malformed_catalog"
        );
    }
}

#[test]
fn duplicate_object_keys_are_refused_before_term_conversion() {
    assert_eq!(
        artifact::parse(br#"{"key":1,"key":2}"#).unwrap_err(),
        "malformed_catalog"
    );
}
