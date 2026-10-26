//! Original catalog/rotation artifact bytes plus their strict integer profile.
//! Flat delegation metadata belongs to authenticated histories and is refused here.
//! High decimal text is portable at the scalar layer; record fields still apply
//! their own horizons. No record-schema, signature, authority, freshness,
//! retained-trust or route verdict is supplied.
use super::canonical::{integer, portable_integer, Result, Term, MAX_BYTES};
use serde_json::Value;

#[derive(Debug)]
pub struct Artifact {
    raw: Vec<u8>,
    term: Term,
}
impl Artifact {
    pub fn bytes(&self) -> &[u8] {
        &self.raw
    }
    pub fn term(&self) -> &Term {
        &self.term
    }
}

pub fn parse(bytes: &[u8]) -> Result<Artifact> {
    if bytes.len() > MAX_BYTES {
        return Err("control_history_limit");
    }
    let value = super::json::parse(bytes).map_err(|_| "malformed_catalog")?;
    portable(&value)?;
    let term = Term::from_carrier(&value).map_err(|_| "malformed_catalog")?;
    Ok(Artifact {
        raw: bytes.to_vec(),
        term,
    })
}

// json::parse already bounds bytes, nodes and wrapper depth and refuses negative,
// fractional/exponent and negative-zero tokens. Check representation BEFORE the
// canonical term decoder can erase small-text aliases. Strings stay opaque.
fn portable(value: &Value) -> Result<()> {
    match value {
        Value::Number(_) => {
            integer(value).map_err(|_| "malformed_catalog")?;
        }
        Value::Array(values) => {
            if values.first().and_then(Value::as_str) == Some("delegation") {
                return Err("malformed_catalog");
            }
            if values.first().and_then(Value::as_str) == Some("int") {
                if values.len() != 2 {
                    return Err("malformed_catalog");
                }
                if !portable_integer(&values[1]).map_err(|_| "malformed_catalog")? {
                    return Err("malformed_catalog");
                }
            }
            for child in values {
                portable(child)?;
            }
        }
        Value::Object(fields) => {
            for child in fields.values() {
                portable(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}
