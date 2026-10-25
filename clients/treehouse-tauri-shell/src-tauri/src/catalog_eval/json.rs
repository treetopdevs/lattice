//! Strict artifact JSON: no duplicate decoded object keys or silent last-wins parsing.
use super::canonical::{Result, MAX_BYTES};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;

pub fn parse(bytes: &[u8]) -> Result<Value> {
    if bytes.len() > MAX_BYTES {
        return Err("catalog_envelope_invalid");
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let value = StrictValue::deserialize(&mut decoder).map_err(|_| "catalog_envelope_invalid")?;
    decoder.end().map_err(|_| "catalog_envelope_invalid")?;
    Ok(value.0)
}

struct StrictValue(Value);
impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> std::result::Result<Self, D::Error> {
        decoder.deserialize_any(StrictVisitor)
    }
}
struct StrictVisitor;
impl<'de> Visitor<'de> for StrictVisitor {
    type Value = StrictValue;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("bounded catalog JSON")
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue(Value::Bool(value)))
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue(Value::Number(Number::from(value))))
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Self::Value, E> {
        let value = u64::try_from(value).map_err(|_| E::custom("negative number"))?;
        self.visit_u64(value)
    }
    fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue(Value::String(value.to_owned())))
    }
    fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue(Value::String(value)))
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }
    fn visit_seq<A: SeqAccess<'de>>(
        self,
        mut sequence: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<StrictValue>()? {
            values.push(value.0);
        }
        Ok(StrictValue(Value::Array(values)))
    }
    fn visit_map<A: MapAccess<'de>>(
        self,
        mut object: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = object.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("duplicate object key"));
            }
            values.insert(key, object.next_value::<StrictValue>()?.0);
        }
        Ok(StrictValue(Value::Object(values)))
    }
}
