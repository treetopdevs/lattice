//! Strict artifact JSON: bounded nodes/depth before allocation and no duplicate decoded keys.
use super::canonical::{Result, MAX_BYTES, MAX_JSON_DEPTH, MAX_NODES};
use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;

pub fn parse(bytes: &[u8]) -> Result<Value> {
    if bytes.len() > MAX_BYTES {
        return Err("catalog_envelope_invalid");
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    // The local seed enforces a finite wrapper-aware depth instead of the
    // library's generic 128-container limit, which clips valid depth-64 terms.
    decoder.disable_recursion_limit();
    let mut remaining = MAX_NODES;
    let value = Seed {
        remaining: &mut remaining,
        depth: 0,
    }
    .deserialize(&mut decoder)
    .map_err(|_| "catalog_envelope_invalid")?;
    decoder.end().map_err(|_| "catalog_envelope_invalid")?;
    Ok(value)
}

struct Seed<'a> {
    remaining: &'a mut usize,
    depth: usize,
}
impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = Value;
    fn deserialize<D: Deserializer<'de>>(self, decoder: D) -> std::result::Result<Value, D::Error> {
        if *self.remaining == 0 || self.depth > MAX_JSON_DEPTH {
            return Err(de::Error::custom("JSON resource limit"));
        }
        *self.remaining -= 1;
        decoder.deserialize_any(StrictVisitor {
            remaining: self.remaining,
            depth: self.depth,
        })
    }
}
struct StrictVisitor<'a> {
    remaining: &'a mut usize,
    depth: usize,
}
impl<'de> Visitor<'de> for StrictVisitor<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("bounded catalog JSON")
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Value, E> {
        Ok(Value::Number(Number::from(value)))
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Value, E> {
        let value = u64::try_from(value).map_err(|_| E::custom("negative number"))?;
        self.visit_u64(value)
    }
    fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Value, E> {
        Ok(Value::String(value.to_owned()))
    }
    fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Value, E> {
        Ok(Value::String(value))
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> std::result::Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(Seed {
            remaining: self.remaining,
            depth: self.depth + 1,
        })? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut object: A) -> std::result::Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = object.next_key_seed(Seed {
            remaining: self.remaining,
            depth: self.depth + 1,
        })? {
            let Value::String(key) = key else {
                return Err(de::Error::custom("non-string object key"));
            };
            if values.contains_key(&key) {
                return Err(de::Error::custom("duplicate object key"));
            }
            let value = object.next_value_seed(Seed {
                remaining: self.remaining,
                depth: self.depth + 1,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}
