//! Bounded JSON with duplicate-name refusal. Artifacts reject negative/floating
//! numbers; raw observations preserve them only for later refusal classification.
use super::canonical::{Result, MAX_BYTES, MAX_DEPTH, MAX_NODES, MAX_OBSERVATION_INPUT};
use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;

pub fn parse(bytes: &[u8]) -> Result<Value> {
    parse_bounded(bytes, MAX_BYTES, MAX_NODES, MAX_DEPTH * 2 + 2, false)
}

pub(crate) fn parse_observation(bytes: &[u8]) -> Result<Value> {
    parse_bounded(
        bytes,
        MAX_OBSERVATION_INPUT,
        MAX_OBSERVATION_INPUT,
        MAX_DEPTH * 2 + 8,
        true,
    )
}

fn parse_bounded(
    bytes: &[u8],
    maximum: usize,
    nodes: usize,
    max_depth: usize,
    json_numbers: bool,
) -> Result<Value> {
    if bytes.len() > maximum {
        return Err(if json_numbers {
            "observation_limit"
        } else {
            "catalog_envelope_invalid"
        });
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    // The local seed enforces a finite wrapper-aware depth instead of the
    // library's generic 128-container limit, which clips valid depth-64 terms.
    decoder.disable_recursion_limit();
    let mut remaining = nodes;
    let value = Seed {
        remaining: &mut remaining,
        depth: 0,
        max_depth,
        json_numbers,
    }
    .deserialize(&mut decoder)
    .map_err(|failure| {
        if json_numbers && failure.to_string().contains("JSON resource limit") {
            "observation_limit"
        } else {
            "catalog_envelope_invalid"
        }
    })?;
    decoder.end().map_err(|_| "catalog_envelope_invalid")?;
    Ok(value)
}

struct Seed<'a> {
    remaining: &'a mut usize,
    depth: usize,
    max_depth: usize,
    json_numbers: bool,
}
impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = Value;
    fn deserialize<D: Deserializer<'de>>(self, decoder: D) -> std::result::Result<Value, D::Error> {
        if *self.remaining == 0 || self.depth > self.max_depth {
            return Err(de::Error::custom("JSON resource limit"));
        }
        *self.remaining -= 1;
        decoder.deserialize_any(StrictVisitor {
            remaining: self.remaining,
            depth: self.depth,
            max_depth: self.max_depth,
            json_numbers: self.json_numbers,
        })
    }
}
struct StrictVisitor<'a> {
    remaining: &'a mut usize,
    depth: usize,
    max_depth: usize,
    json_numbers: bool,
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
        if value < 0 && self.json_numbers {
            return Ok(Value::Number(value.into()));
        }
        let value = u64::try_from(value).map_err(|_| E::custom("negative number"))?;
        self.visit_u64(value)
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Value, E> {
        if !self.json_numbers {
            return Err(E::custom("floating number"));
        }
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("nonfinite number"))
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
            max_depth: self.max_depth,
            json_numbers: self.json_numbers,
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
            max_depth: self.max_depth,
            json_numbers: self.json_numbers,
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
                max_depth: self.max_depth,
                json_numbers: self.json_numbers,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}
