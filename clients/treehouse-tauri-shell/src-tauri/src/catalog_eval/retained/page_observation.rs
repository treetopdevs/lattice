//! Grammar-preserving ownership projection. Malformed proof metadata is a deferred
//! refusal marker, never a skipped authentication stage or a validity receipt.
//! Exact page bytes stay caller-owned; this projection is not an input digest.
use super::{super::json, page_header, proof_metadata};
use serde_json::{Map, Value};

fn refusal(reason: &'static str) -> &'static str {
    if reason == "observation_limit" {
        "invalid_verified_history"
    } else {
        "malformed_catalog"
    }
}
pub(super) fn parse(bytes: &[u8]) -> Result<Value, &'static str> {
    // Preserve the existing header-before-owned-observation stage ordering.
    page_header::validate(bytes)?;
    // Scan every subtree before discarding anything: duplicate names, invalid
    // Unicode/numbers, depth/node limits and trailing bytes retain precedence.
    // Sub-parses below may restart depth only because this complete scan has
    // already checked the original global depth, counters and grammar.
    json::validate_observation(bytes).map_err(refusal)?;
    let fields = page_header::object(
        bytes,
        &["catalogs", "rotations", "histories", "cutoffProofs"],
    )?;
    let mut page = Map::new();
    for name in ["catalogs", "rotations", "histories"] {
        page.insert(
            name.into(),
            json::parse_observation(fields[name].get().as_bytes()).map_err(refusal)?,
        );
    }
    let mut proofs = Vec::new();
    page_header::each(fields["cutoffProofs"], |raw| {
        let readable = page_header::object(raw.get().as_bytes(), &["cutoff", "history"])
            .is_ok_and(|fields| proof_metadata::shape_valid(fields["cutoff"]));
        let value = if readable {
            json::parse_observation(raw.get().as_bytes()).map_err(refusal)?
        } else {
            // Malformed cutoff/root shape guarantees the ordinary proof stage
            // returns malformed_catalog with no proof-derived ids. Keep the row
            // position; earlier proof or graph faults and security fallback still
            // execute at their original stages.
            Value::Null
        };
        proofs.push(value);
        Ok(())
    })?;
    page.insert("cutoffProofs".into(), Value::Array(proofs));
    let page = Value::Object(page);
    if !json::within_observation(&page, 205) {
        return Err("invalid_verified_history");
    }
    Ok(page)
}

// Values can be produced by a bounded internal merge whose serialized spelling
// exceeds one transport page. This constructor supplies shape/budget checks only.
pub(super) fn observe(page: Value) -> Result<Value, &'static str> {
    page_header::validate_value(&page)?;
    if !json::within_observation(&page, 205) {
        return Err("invalid_verified_history");
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn owned(bytes: &[u8]) -> Result<Value, &'static str> {
        page_header::validate(bytes)?;
        let value = json::parse_observation(bytes).map_err(refusal)?;
        if !json::within_observation(&value, 205) {
            return Err("invalid_verified_history");
        }
        Ok(value)
    }
    fn wrapper(proof: &str) -> String {
        format!("{{\"catalogs\":[],\"rotations\":[],\"histories\":[],\"cutoffProofs\":[{proof}]}}")
    }
    #[test]
    fn value_page_logical_edge_and_shape_precedence() {
        let mut page = json!({"catalogs":[],"rotations":[],"histories":[],"cutoffProofs":[]});
        let keys: usize = page.as_object().unwrap().keys().map(String::len).sum();
        page["catalogs"] =
            json!(["x".repeat(super::super::super::canonical::MAX_OBSERVATION_INPUT - keys)]);
        let mut page = observe(page).unwrap();
        let Value::String(text) = &mut page["catalogs"][0] else {
            unreachable!()
        };
        text.push('x');
        assert!(matches!(
            observe(page.clone()),
            Err("invalid_verified_history")
        ));
        page["histories"] = json!({});
        assert!(matches!(observe(page), Err("malformed_catalog")));
    }

    #[test]
    fn projection_keeps_valid_cutoff_metadata_and_defers_malformed_rows_in_order() {
        let input = json!({"catalogs":[],"rotations":[],"histories":[],"cutoffProofs":[
            [],{"unexpected":[[],[]]},null,true,7,"text",
            {"cutoff":{"replica":"claimed","frontier":[],"logDigest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"history":{"raw":[-0.0,1.5,-1]}}
        ]});
        let bytes = serde_json::to_vec(&input).unwrap();
        let result = parse(&bytes).unwrap();
        assert_eq!(
            result["cutoffProofs"],
            json!([null, null, null, null, null, null, input["cutoffProofs"][6]])
        );
        let positive = json!({"catalogs":["raw"],"rotations":[],"histories":[],"cutoffProofs":[input["cutoffProofs"][6]]});
        let bytes = serde_json::to_vec(&positive).unwrap();
        assert_eq!(parse(&bytes), owned(&bytes));
    }
    #[test]
    fn discarded_subtree_errors_and_empty_depth_edges_keep_original_precedence() {
        for raw in [
            r#"[{"x":0,"x":1}]"#,
            r#"["\ud800"]"#,
            "[1e999]",
            "[false,]",
            r#"{"unexpected":{"x":0,"x":1}}"#,
        ] {
            let bytes = wrapper(raw);
            assert!(owned(bytes.as_bytes()).is_err(), "{raw}");
            assert_eq!(
                parse(bytes.as_bytes()).map(|_| ()),
                owned(bytes.as_bytes()).map(|_| ())
            );
        }
        for depth in 0..210 {
            for leaf in ["[]", "[null]", "{}", "{\"x\":null}"] {
                let nested = format!("{}{}{}", "[".repeat(depth), leaf, "]".repeat(depth));
                for tail in ["", ",{\"x\":0,\"x\":1}"] {
                    let bytes = wrapper(&format!("[{nested}{tail}]"));
                    assert_eq!(
                        parse(bytes.as_bytes()).map(|_| ()),
                        owned(bytes.as_bytes()).map(|_| ()),
                        "depth={depth}, leaf={leaf}, tail={tail}"
                    );
                    let trailing = bytes + " trailing";
                    assert_eq!(
                        parse(trailing.as_bytes()).map(|_| ()),
                        owned(trailing.as_bytes()).map(|_| ())
                    );
                }
            }
        }
    }

    #[test]
    fn kept_proof_and_history_subparses_keep_original_global_depth() {
        for depth in 0..210 {
            for leaf in ["[]", "[null]", "{}", "{\"x\":1.0}"] {
                let nested = format!("{}{}{}", "[".repeat(depth), leaf, "]".repeat(depth));
                let cutoff = r#"{"replica":"claimed","frontier":[],"logDigest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#;
                let proof = wrapper(&format!("{{\"cutoff\":{cutoff},\"history\":{nested}}}"));
                let history = format!("{{\"catalogs\":[],\"rotations\":[],\"histories\":[{{\"replica\":\"replica:treehouse:space:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA#authority:bounded-continuation-v1#root:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"frames\":[{nested}],\"rejected\":[]}}],\"cutoffProofs\":[]}}");
                for raw in [proof, history] {
                    if depth == 0 {
                        assert!(owned(raw.as_bytes()).is_ok());
                    }
                    assert_eq!(
                        parse(raw.as_bytes()),
                        owned(raw.as_bytes()),
                        "depth={depth}, leaf={leaf}"
                    );
                }
                let later_duplicate = wrapper(&format!(
                    "{{\"cutoff\":{nested},\"history\":{{\"x\":0,\"x\":1}}}}"
                ));
                assert_eq!(
                    parse(later_duplicate.as_bytes()),
                    owned(later_duplicate.as_bytes())
                );
            }
        }
    }
}
