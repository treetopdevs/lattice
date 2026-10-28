//! Bounded JSON with duplicate-name refusal. Artifacts reject negative/floating
//! numbers; raw observations preserve them only for later refusal classification.
use super::canonical::{
    Result, MAX_BYTES, MAX_DEPTH, MAX_JSON_DEPTH, MAX_NODES, MAX_OBSERVATION_INPUT,
};
use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::{cell::Cell, collections::BTreeSet, fmt};

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ObservationCounts {
    pub nodes: usize,
    pub string_bytes: usize,
    pub array_elements: usize,
    pub object_fields: usize,
}
#[derive(Default)]
struct Preflight {
    depth_exceeded: Cell<bool>,
    strings: Cell<usize>,
    array_elements: Cell<usize>,
    object_fields: Cell<usize>,
}

/// Validate the complete grammar without owning its value tree. Counts describe
/// raw JSON, not verified evidence or a native heap-allocation receipt.
pub(super) fn validate_observation(bytes: &[u8]) -> Result<ObservationCounts> {
    if bytes.len() > MAX_OBSERVATION_INPUT {
        return Err("observation_limit");
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    decoder.disable_recursion_limit();
    let mut remaining = MAX_OBSERVATION_INPUT;
    let preflight = Preflight::default();
    Seed {
        remaining: &mut remaining,
        depth: 0,
        max_depth: (MAX_DEPTH + 1) * 3 + 10,
        json_numbers: true,
        discard: true,
        preflight: Some(&preflight),
    }
    .deserialize(&mut decoder)
    .map_err(|failure| {
        if failure.to_string().contains("JSON resource limit") {
            "observation_limit"
        } else {
            "catalog_envelope_invalid"
        }
    })?;
    decoder.end().map_err(|_| "catalog_envelope_invalid")?;
    // The old owned parser completes syntax validation before the subsequent
    // container-depth walk. Do not let an empty deep container hide later syntax.
    if preflight.depth_exceeded.get() || preflight.strings.get() > MAX_OBSERVATION_INPUT {
        return Err("observation_limit");
    }
    Ok(ObservationCounts {
        nodes: MAX_OBSERVATION_INPUT - remaining,
        string_bytes: preflight.strings.get(),
        array_elements: preflight.array_elements.get(),
        object_fields: preflight.object_fields.get(),
    })
}

pub fn parse(bytes: &[u8]) -> Result<Value> {
    parse_bounded(bytes, MAX_BYTES, MAX_NODES, MAX_JSON_DEPTH, false)
}

pub(crate) fn parse_observation(bytes: &[u8]) -> Result<Value> {
    parse_bounded(
        bytes,
        MAX_OBSERVATION_INPUT,
        MAX_OBSERVATION_INPUT,
        (MAX_DEPTH + 1) * 3 + 10,
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
        discard: false,
        preflight: None,
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

/// Account an already-owned observation without an encoded-size shortcut.
/// Internal unions can exceed one external transport's encoded byte budget;
/// the source still bounds every value/key occurrence and UTF-8 string byte.
pub(super) fn within_observation(value: &Value, max_depth: usize) -> bool {
    enum Item<'a> {
        Value(&'a Value),
        Key(&'a str),
    }
    let mut pending: Vec<Box<dyn Iterator<Item = Item<'_>> + '_>> =
        vec![Box::new(std::iter::once(Item::Value(value)))];
    let mut nodes = 0usize;
    let mut bytes = 0usize;
    while !pending.is_empty() {
        let Some(item) = pending.last_mut().and_then(|items| items.next()) else {
            pending.pop();
            continue;
        };
        nodes += 1;
        if nodes > MAX_OBSERVATION_INPUT {
            return false;
        }
        let string = match item {
            Item::Key(key) => Some(key),
            Item::Value(Value::String(value)) => Some(value.as_str()),
            Item::Value(Value::Array(values)) => {
                if pending.len() > max_depth {
                    return false;
                }
                pending.push(Box::new(values.iter().map(Item::Value)));
                None
            }
            Item::Value(Value::Object(values)) => {
                if pending.len() > max_depth {
                    return false;
                }
                pending.push(Box::new(
                    values
                        .iter()
                        .flat_map(|(key, value)| [Item::Key(key), Item::Value(value)]),
                ));
                None
            }
            _ => None,
        };
        if let Some(string) = string {
            let Some(total) = bytes.checked_add(string.len()) else {
                return false;
            };
            bytes = total;
            if bytes > MAX_OBSERVATION_INPUT {
                return false;
            }
        }
    }
    true
}

struct Seed<'a> {
    remaining: &'a mut usize,
    depth: usize,
    max_depth: usize,
    json_numbers: bool,
    discard: bool,
    preflight: Option<&'a Preflight>,
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
            discard: self.discard,
            preflight: self.preflight,
        })
    }
}
struct StrictVisitor<'a> {
    remaining: &'a mut usize,
    depth: usize,
    max_depth: usize,
    json_numbers: bool,
    discard: bool,
    preflight: Option<&'a Preflight>,
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
        if let Some(counts) = self.preflight {
            counts.strings.set(counts.strings.get() + value.len());
        }
        Ok(if self.discard {
            Value::Null
        } else {
            Value::String(value.to_owned())
        })
    }
    fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Value, E> {
        if let Some(counts) = self.preflight {
            counts.strings.set(counts.strings.get() + value.len());
        }
        Ok(if self.discard {
            Value::Null
        } else {
            Value::String(value)
        })
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> std::result::Result<Value, A::Error> {
        if let Some(counts) = self.preflight {
            if self.depth >= self.max_depth {
                counts.depth_exceeded.set(true);
            }
        }
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(Seed {
            remaining: self.remaining,
            depth: self.depth + 1,
            max_depth: self.max_depth,
            json_numbers: self.json_numbers,
            discard: self.discard,
            preflight: self.preflight,
        })? {
            if let Some(counts) = self.preflight {
                counts.array_elements.set(counts.array_elements.get() + 1);
            }
            if !self.discard {
                values.push(value);
            }
        }
        Ok(if self.discard {
            Value::Null
        } else {
            Value::Array(values)
        })
    }
    fn visit_map<A: MapAccess<'de>>(self, mut object: A) -> std::result::Result<Value, A::Error> {
        if let Some(counts) = self.preflight {
            if self.depth >= self.max_depth {
                counts.depth_exceeded.set(true);
            }
        }
        let mut values = Map::new();
        let mut keys = BTreeSet::new();
        while let Some(key) = object.next_key_seed(Seed {
            remaining: self.remaining,
            depth: self.depth + 1,
            max_depth: self.max_depth,
            json_numbers: self.json_numbers,
            discard: false,
            preflight: self.preflight,
        })? {
            let Value::String(key) = key else {
                return Err(de::Error::custom("non-string object key"));
            };
            let key = if self.discard {
                if !keys.insert(key) {
                    return Err(de::Error::custom("duplicate object key"));
                }
                None
            } else {
                if values.contains_key(&key) {
                    return Err(de::Error::custom("duplicate object key"));
                }
                Some(key)
            };
            let value = object.next_value_seed(Seed {
                remaining: self.remaining,
                depth: self.depth + 1,
                max_depth: self.max_depth,
                json_numbers: self.json_numbers,
                discard: self.discard,
                preflight: self.preflight,
            })?;
            if let Some(counts) = self.preflight {
                counts.object_fields.set(counts.object_fields.get() + 1);
            }
            if let Some(key) = key {
                values.insert(key, value);
            }
        }
        Ok(if self.discard {
            Value::Null
        } else {
            Value::Object(values)
        })
    }
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    #[test]
    fn no_tree_scan_accounts_every_raw_node_key_and_string() {
        let raw = r#"{"a":[[],{"b":"é"},-1,1.0,true,null],"c":"x"}"#;
        assert_eq!(
            validate_observation(raw.as_bytes()).unwrap(),
            ObservationCounts {
                nodes: 13,
                string_bytes: 6,
                array_elements: 6,
                object_fields: 3,
            }
        );
        assert!(within_observation(
            &parse_observation(raw.as_bytes()).unwrap(),
            205
        ));
        let raw = format!(
            "[{}]",
            std::iter::repeat_n("[]", 65_536)
                .collect::<Vec<_>>()
                .join(",")
        );
        assert_eq!(
            validate_observation(raw.as_bytes()).unwrap(),
            ObservationCounts {
                nodes: 65_537,
                string_bytes: 0,
                array_elements: 65_536,
                object_fields: 0,
            }
        );
    }
    #[test]
    fn owned_observation_counts_utf8_keys_and_container_levels() {
        let exact = Value::String("x".repeat(MAX_OBSERVATION_INPUT));
        assert!(within_observation(&exact, 203));
        // The object key is a separate occurrence and exceeds the same total.
        let keyed = Value::Object(Map::from_iter([("k".into(), exact)]));
        assert!(!within_observation(&keyed, 203));
        let mut value = Value::String("leaf".into());
        for _ in 0..203 {
            value = Value::Array(vec![value]);
        }
        assert!(within_observation(&value, 203));
        value = Value::Array(vec![value]);
        assert!(!within_observation(&value, 203));
    }
}
