//! Catalog observation-only JSON number interpretation. Ordinary frame and
//! artifact decoders remain strict; callers retain the original raw evidence.
use serde_json::Value;
use std::borrow::Cow;

const INVALID: &str = "catalog_envelope_invalid";
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

pub(super) fn safe_integer(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= MAX_SAFE && n.fract() == 0.0)
        .map(|n| n as u64)
}

pub(super) fn frame_view(value: &Value) -> Result<Cow<'_, Value>, &'static str> {
    const FIELDS: [&str; 9] = [
        "v", "id", "replica", "author", "deps", "kind", "body", "cap", "sig",
    ];
    if !value
        .as_object()
        .is_some_and(|m| m.len() == FIELDS.len() && FIELDS.iter().all(|key| m.contains_key(*key)))
        || !super::json::within_observation(value, 205)
    {
        return Err(INVALID);
    }
    fn needs_view(value: &Value) -> bool {
        match value {
            Value::Number(n) => n.is_f64() && safe_integer(value).is_some(),
            Value::Array(values) => values.iter().any(needs_view),
            Value::Object(values) => values.values().any(needs_view),
            _ => false,
        }
    }
    if !needs_view(value) {
        return Ok(Cow::Borrowed(value));
    }
    fn convert(value: &mut Value) {
        match value {
            Value::Number(n) if n.is_f64() => {
                if let Some(n) = safe_integer(value) {
                    *value = Value::from(n);
                }
            }
            Value::Array(values) => values.iter_mut().for_each(convert),
            Value::Object(values) => values.values_mut().for_each(convert),
            _ => {}
        }
    }
    let mut view = value.clone();
    convert(&mut view);
    Ok(Cow::Owned(view))
}

/// Structural catalog-value equality. Safe integral JSON spellings represent the
/// same value; strings, object fields, array positions and other scalars do not.
pub(super) fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(_), Value::Number(_)) => match (safe_integer(a), safe_integer(b)) {
            (Some(a), Some(b)) => a == b,
            _ => a == b,
        },
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| values_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| values_equal(a, b)))
        }
        _ => a == b,
    }
}
