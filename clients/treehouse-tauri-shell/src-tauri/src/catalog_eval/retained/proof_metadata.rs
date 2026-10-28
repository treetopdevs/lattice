//! Borrowed cutoff shape only. No derived cutoff, history membership, signer or
//! authority verdict is supplied here. Full JSON grammar must be checked first.
use super::{super::frame, page_header, CUTOFF_FIELDS};
use serde::de::{self, Visitor};
use serde::Deserializer as _;
use serde_json::value::RawValue;
use std::fmt;

struct Text<F>(F);
impl<'de, F, T> Visitor<'de> for Text<F>
where
    F: FnOnce(&str) -> Option<T>,
{
    type Value = Option<T>;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("cutoff metadata text")
    }
    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok((self.0)(value))
    }
}
fn text<T>(raw: &RawValue, observe: impl FnOnce(&str) -> Option<T>) -> Option<T> {
    let mut decoder = serde_json::Deserializer::from_str(raw.get());
    let value = decoder.deserialize_str(Text(observe)).ok()??;
    decoder.end().ok()?;
    Some(value)
}

pub(super) fn shape_valid(raw: &RawValue) -> bool {
    let Ok(fields) = page_header::object(raw.get().as_bytes(), &CUTOFF_FIELDS) else {
        return false;
    };
    // Claimed replica text is intentionally not family-bounded here. Its match
    // with a real derived cutoff remains the ordinary proof stage's decision.
    if text(fields["replica"], |value| (!value.is_empty()).then_some(())).is_none()
        || text(fields["logDigest"], |value| {
            frame::identifier(value).is_ok().then_some(())
        })
        .is_none()
    {
        return false;
    }
    let mut previous: Option<String> = None;
    page_header::each(fields["frontier"], |raw| {
        text(raw, |id| {
            if frame::identifier(id).is_err()
                || previous.as_deref().is_some_and(|prior| prior >= id)
            {
                return None;
            }
            // Only a successfully checked43-byte identifier is ever retained.
            previous = Some(id.to_owned());
            Some(())
        })
        .ok_or("malformed_catalog")
    })
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use serde_json::{json, Value};
    fn compare(value: &Value) {
        for bytes in [
            serde_json::to_vec(value).unwrap(),
            serde_json::to_vec_pretty(value).unwrap(),
        ] {
            let raw: &RawValue = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(shape_valid(raw), super::super::valid_cutoff(value));
        }
    }
    #[test]
    fn borrowed_metadata_matches_owned_cutoff_schema_and_frontier_order() {
        let low = URL_SAFE_NO_PAD.encode([0u8; 32]);
        let high = URL_SAFE_NO_PAD.encode([255u8; 32]);
        let base =
            json!({"replica":"claimed","logDigest":low,"frontier":[low.clone(),high.clone()]});
        assert!(super::super::valid_cutoff(&base));
        compare(&base);
        for field in CUTOFF_FIELDS {
            let mut missing = base.clone();
            missing.as_object_mut().unwrap().remove(field);
            compare(&missing);
            for value in [
                Value::Null,
                json!(true),
                json!(7),
                json!(1.0),
                json!(""),
                json!("text"),
                json!("é"),
                json!([]),
                json!([null]),
                json!({}),
                json!({"unexpected":[[],[]]}),
            ] {
                let mut candidate = base.clone();
                candidate[field] = value;
                compare(&candidate);
            }
        }
        for frontier in [
            json!([]),
            json!([low]),
            json!([low, low]),
            json!([high, low]),
            json!([low, "!".repeat(43)]),
            json!(["B".repeat(43)]),
            json!([[]]),
        ] {
            let mut candidate = base.clone();
            candidate["frontier"] = frontier;
            compare(&candidate);
        }
        let mut extra = base.clone();
        extra["unexpected"] = json!([]);
        compare(&extra);
        for value in [
            Value::Null,
            json!(false),
            json!(7),
            json!([]),
            json!("text"),
        ] {
            compare(&value);
        }
        let mut large_claim = base.clone();
        large_claim["replica"] = json!("z".repeat(4 * 1024 * 1024));
        assert!(super::super::valid_cutoff(&large_claim));
        compare(&large_claim);
    }
    #[test]
    fn escaped_identifiers_and_keys_use_decoded_order_without_normalizing_values() {
        let id = "A".repeat(43);
        let value = json!({"replica":"claimed","logDigest":id,"frontier":[id]});
        let escaped = serde_json::to_string(&value)
            .unwrap()
            .replace('A', "\\u0041")
            .replace("\"frontier\"", "\"\\u0066rontier\"")
            .replace("\"claimed\"", r#""clai\u006ded""#);
        let raw: &RawValue = serde_json::from_str(&escaped).unwrap();
        assert!(shape_valid(raw));
        let duplicate = format!(
            "{{\"replica\":\"claimed\",\"logDigest\":\"{id}\",\"frontier\":[\"{id}\",\"{}\"]}}",
            "\\u0041".repeat(43)
        );
        let raw: &RawValue = serde_json::from_str(&duplicate).unwrap();
        assert!(!shape_valid(raw));
        let invalid =
            format!(r#"{{"replica":"claimed","logDigest":"{id}","frontier":["\u0021"]}}"#);
        let raw: &RawValue = serde_json::from_str(&invalid).unwrap();
        let decoded: Value = serde_json::from_str(&invalid).unwrap();
        assert!(!shape_valid(raw));
        assert_eq!(shape_valid(raw), super::super::valid_cutoff(&decoded));
    }
}
