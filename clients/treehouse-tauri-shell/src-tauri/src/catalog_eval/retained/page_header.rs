//! Bounded structural preflight before constructing a page's owned JSON tree.
//! RawValue scans nested bodies iteratively and borrows their bytes. Only root
//! fields, array counts, history shapes and replica families are interpreted;
//! this supplies no authentication, authority or accepted page receipt.
use super::super::{canonical::MAX_OBSERVATION_INPUT, histories};
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::Deserializer as _;
use serde_json::value::RawValue;
use std::{collections::BTreeMap, fmt};
const MALFORMED: &str = "malformed_catalog";
type Fields<'de> = BTreeMap<&'static str, &'de RawValue>;

struct Object(&'static [&'static str]);
impl<'de> DeserializeSeed<'de> for Object {
    type Value = Fields<'de>;
    fn deserialize<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for Object {
    type Value = Fields<'de>;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("closed page metadata object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut fields = BTreeMap::new();
        while let Some(key) = map.next_key::<String>()? {
            let name = self
                .0
                .iter()
                .copied()
                .find(|name| *name == key)
                .ok_or_else(|| de::Error::custom("unknown page metadata field"))?;
            if fields
                .insert(name, map.next_value::<&'de RawValue>()?)
                .is_some()
            {
                return Err(de::Error::custom("duplicate page metadata field"));
            }
        }
        if fields.len() != self.0.len() {
            return Err(de::Error::custom("missing page metadata field"));
        }
        Ok(fields)
    }
}
fn object<'de>(
    bytes: &'de [u8],
    names: &'static [&'static str],
) -> Result<Fields<'de>, &'static str> {
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    decoder.disable_recursion_limit();
    let fields = Object(names)
        .deserialize(&mut decoder)
        .map_err(|_| MALFORMED)?;
    decoder.end().map_err(|_| MALFORMED)?;
    Ok(fields)
}
struct Each<'a, F> {
    visit: &'a mut F,
    refusal: &'a mut Option<&'static str>,
}
impl<'de, F> Visitor<'de> for Each<'_, F>
where
    F: FnMut(&'de RawValue) -> Result<(), &'static str>,
{
    type Value = ();
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("page metadata array")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<(), A::Error> {
        while let Some(value) = sequence.next_element::<&'de RawValue>()? {
            if let Err(reason) = (self.visit)(value) {
                *self.refusal = Some(reason);
                return Err(de::Error::custom("page metadata refusal"));
            }
        }
        Ok(())
    }
}
fn each<'de>(
    raw: &'de RawValue,
    mut visit: impl FnMut(&'de RawValue) -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    let mut decoder = serde_json::Deserializer::from_str(raw.get());
    decoder.disable_recursion_limit();
    let mut refusal = None;
    let result = decoder.deserialize_seq(Each {
        visit: &mut visit,
        refusal: &mut refusal,
    });
    if let Some(reason) = refusal {
        return Err(reason);
    }
    result.map_err(|_| MALFORMED)?;
    decoder.end().map_err(|_| MALFORMED)
}
fn array(raw: &RawValue) -> bool {
    raw.get().as_bytes().first() == Some(&b'[')
}
fn summary(raw: &RawValue) -> Result<(usize, bool), &'static str> {
    let mut count = 0usize;
    let mut strings = true;
    each(raw, |value| {
        count += 1;
        strings &= value.get().as_bytes().first() == Some(&b'"');
        Ok(())
    })?;
    Ok((count, strings))
}

pub(super) fn validate(bytes: &[u8]) -> Result<(), &'static str> {
    // This is the existing external transport profile. The structural pass
    // never scans or allocates against an unbounded encoded candidate.
    if bytes.len() > MAX_OBSERVATION_INPUT {
        return Err("invalid_verified_history");
    }
    let page = object(
        bytes,
        &["catalogs", "rotations", "histories", "cutoffProofs"],
    )?;
    if page.values().any(|raw| !array(raw)) {
        return Err(MALFORMED);
    }
    let (catalog_count, catalog_strings) = summary(page["catalogs"])?;
    let (rotation_count, rotation_strings) = summary(page["rotations"])?;
    if catalog_count + rotation_count > 32 {
        return Err("control_history_limit");
    }
    if !catalog_strings || !rotation_strings {
        return Err(MALFORMED);
    }
    let mut wrong_family = false;
    each(page["histories"], |raw| {
        let history = object(raw.get().as_bytes(), &["replica", "frames", "rejected"])?;
        let replica: String =
            serde_json::from_str(history["replica"].get()).map_err(|_| MALFORMED)?;
        if replica.is_empty() || !array(history["frames"]) || !array(history["rejected"]) {
            return Err(MALFORMED);
        }
        each(history["rejected"], |raw| {
            let rejected = object(raw.get().as_bytes(), &["frame", "reason"])?;
            let reason: String =
                serde_json::from_str(rejected["reason"].get()).map_err(|_| MALFORMED)?;
            if reason != "bad_signature" {
                return Err(MALFORMED);
            }
            Ok(())
        })?;
        wrong_family |= !histories::catalog_family(&replica);
        Ok(())
    })?;
    // Shape of every history precedes family of any history, matching both
    // owners. The owned observation parser and budget check still run next.
    if wrong_family {
        return Err("wrong_catalog_scope");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transport_json_profile_remains_closed_and_utf8() {
        for raw in [
            r#"{"catalogs":[],"catalogs":[],"rotations":[],"histories":[],"cutoffProofs":[]}"#,
            r#"{"catalogs":[],"rotations":[],"histories":[],"cutoffProofs":[]} trailing"#,
            r#"{"catalogs":[],"rotations":[],"histories":[{"replica":"foreign","replica":"foreign","frames":[],"rejected":[]}],"cutoffProofs":[]}"#,
            r#"{"catalogs":[],"rotations":[],"histories":[{"replica":"\ud800","frames":[],"rejected":[]}],"cutoffProofs":[]}"#,
        ] {
            assert_eq!(validate(raw.as_bytes()), Err(MALFORMED));
        }
        // Opaque syntax may be borrowed by preflight, but it cannot widen the
        // existing owned JSON parser's Unicode profile or reach authentication.
        let opaque = r#"{"catalogs":["\ud800"],"rotations":[],"histories":[],"cutoffProofs":[]}"#;
        assert_eq!(validate(opaque.as_bytes()), Ok(()));
        assert!(super::super::super::json::parse_observation(opaque.as_bytes()).is_err());
    }
    #[test]
    fn structural_priority_survives_opaque_deep_bodies() {
        let deep = format!("{}null{}", "[".repeat(4096), "]".repeat(4096));
        let raw = format!(
            r#"{{"catalogs":[],"rotations":[],"histories":[{{"replica":"foreign","frames":[],"rejected":[{{"frame":{deep},"reason":"bad_signature"}}]}}],"cutoffProofs":[]}}"#
        );
        assert_eq!(validate(raw.as_bytes()), Err("wrong_catalog_scope"));
        let raw = serde_json::json!({"catalogs":vec!["not JSON";33],"rotations":[],"histories":[{"replica":"foreign","frames":[],"rejected":[]}],"cutoffProofs":[]});
        assert_eq!(
            validate(&serde_json::to_vec(&raw).unwrap()),
            Err("control_history_limit")
        );
        let raw=br#"{"catalogs":[null],"rotations":[],"histories":[{"replica":"foreign","frames":[],"rejected":[]}],"cutoffProofs":[]}"#;
        assert_eq!(validate(raw), Err(MALFORMED));
        let raw=br#"{"catalogs":[],"rotations":[],"histories":[{"replica":"foreign","frames":[],"rejected":[]},{"replica":"","frames":[],"rejected":[]}],"cutoffProofs":[]}"#;
        assert_eq!(validate(raw), Err(MALFORMED));
    }
    #[test]
    fn encoded_transport_limit_precedes_scanning_without_trimming() {
        let mut raw =
            br#"{"catalogs":[],"rotations":[],"histories":[],"cutoffProofs":[]}"#.to_vec();
        raw.resize(MAX_OBSERVATION_INPUT, b' ');
        assert_eq!(validate(&raw), Ok(()));
        raw.push(b' ');
        assert_eq!(validate(&raw), Err("invalid_verified_history"));
    }
}
