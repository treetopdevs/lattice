//! Closed retained-snapshot input ownership, before graph/authentication replay.
//! A parsed snapshot remains unverified: it proves neither saved-store provenance
//! nor valid signatures, closure, watermarks, witnesses, freshness or routes.
use super::{delegations, json};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use serde_json::Value;
use std::collections::BTreeSet;

const RECOVERY: &str = "trust_recovery_required";
const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
const MAX_ARTIFACT_BYTES: usize = 16 * 1024 * 1024;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

pub struct UnverifiedSnapshot {
    raw: Value,
}
impl UnverifiedSnapshot {
    /// Bound encoded snapshot bytes before parsing. This is the candidate-store
    /// limit, not an increase to per-artifact or history admission budgets.
    pub fn parse(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.is_empty() || bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err(RECOVERY);
        }
        let raw = json::parse_observation(bytes).map_err(|_| RECOVERY)?;
        if !within_source_depth(&raw) || !state_valid(&raw) {
            return Err(RECOVERY);
        }
        Ok(Self { raw })
    }
    pub fn raw(&self) -> &Value {
        &self.raw
    }
}
impl std::fmt::Debug for UnverifiedSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // A failed result must not dump up to32MiB of candidate evidence.
        f.debug_struct("UnverifiedSnapshot").finish_non_exhaustive()
    }
}
fn within_source_depth(value: &Value) -> bool {
    // Source counts container levels from1; scalars inside the deepest allowed
    // container do not consume another container level. Keep traversal memory
    // proportional to depth, not to the width of an untrusted array/object.
    const MAX_CONTAINER_LEVEL: usize = (64 + 1) * 3 + 10;
    let mut pending: Vec<Box<dyn Iterator<Item = &Value> + '_>> =
        vec![Box::new(std::iter::once(value))];
    while !pending.is_empty() {
        let Some(next) = pending.last_mut().and_then(|values| values.next()) else {
            pending.pop();
            continue;
        };
        match next {
            Value::Array(values) => {
                if pending.len() > MAX_CONTAINER_LEVEL {
                    return false;
                }
                if !values.is_empty() {
                    pending.push(Box::new(values.iter()));
                }
            }
            Value::Object(values) => {
                if pending.len() > MAX_CONTAINER_LEVEL {
                    return false;
                }
                if !values.is_empty() {
                    pending.push(Box::new(values.values()));
                }
            }
            _ => {}
        }
    }
    true
}
fn closed(value: &Value, names: &[&str]) -> bool {
    value.as_object().is_some_and(|map| {
        map.len() == names.len() && names.iter().all(|name| map.contains_key(*name))
    })
}
fn text(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty())
}
fn digest(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 43
            && URL_SAFE_NO_PAD
                .decode(s)
                .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == s)
    })
}
fn key(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 44
            && STANDARD
                .decode(s)
                .is_ok_and(|bytes| bytes.len() == 32 && STANDARD.encode(bytes) == s)
    })
}
fn safe(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n >= 0.0 && n <= MAX_SAFE && n.fract() == 0.0)
}
fn one(value: &Value) -> bool {
    safe(value) && value.as_f64() == Some(1.0)
}
fn ids(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|values| values.iter().all(digest))
}
fn review_valid(value: &Value) -> bool {
    if !closed(
        value,
        &[
            "version",
            "product",
            "space",
            "spaceRoot",
            "bootstrapId",
            "observedBootstrapIds",
            "disposition",
        ],
    ) || !one(&value["version"])
        || value["product"] != "treehouse"
        || !value["space"].as_str().is_some_and(|s| {
            s.starts_with("replica:treehouse:space:") && delegations::bounded_family(s)
        })
        || !key(&value["spaceRoot"])
        || !digest(&value["bootstrapId"])
        || value["disposition"] != "pin_exact_observed_bootstrap"
        || !ids(&value["observedBootstrapIds"])
    {
        return false;
    }
    let observed = value["observedBootstrapIds"].as_array().unwrap();
    observed.contains(&value["bootstrapId"])
        && observed
            .windows(2)
            .all(|pair| pair[0].as_str() < pair[1].as_str())
}
fn history_valid(value: &Value) -> bool {
    closed(value, &["replica", "frames", "rejected"])
        && text(&value["replica"])
        && value["frames"].is_array()
        && value["rejected"].as_array().is_some_and(|records| {
            records.iter().all(|record| {
                closed(record, &["frame", "reason"]) && record["reason"] == "bad_signature"
            })
        })
}
fn records_valid(value: &Value) -> bool {
    let Some(records) = value.as_array() else {
        return false;
    };
    if records.len() > 1024 {
        return false;
    }
    let mut seen = BTreeSet::new();
    records.iter().all(|record| {
        closed(record, &["id", "json"])
            && digest(&record["id"])
            && record["json"].is_string()
            && seen.insert(record["id"].as_str().unwrap())
    })
}
fn watermark_valid(value: &Value) -> bool {
    value.is_null()
        || (closed(value, &["binding", "generation", "catalog", "revision"])
            && digest(&value["binding"])
            && digest(&value["catalog"])
            && safe(&value["generation"])
            && safe(&value["revision"]))
}
fn block_valid(value: &Value) -> bool {
    value.is_null()
        || (closed(
            value,
            &[
                "reason",
                "bindings",
                "catalogs",
                "bootstrapIds",
                "opIds",
                "pendingProofIds",
                "triggers",
                "authorityWitnesses",
            ],
        ) && matches!(
            value["reason"].as_str(),
            Some("catalog_fork" | "authority_changed" | "control_history_limit")
        ) && [
            "bindings",
            "catalogs",
            "bootstrapIds",
            "opIds",
            "pendingProofIds",
        ]
        .iter()
        .all(|name| ids(&value[*name]))
            && value["authorityWitnesses"]
                .as_array()
                .is_some_and(|witnesses| {
                    witnesses.iter().all(|w| {
                        closed(w, &["replica", "frontier", "opIds"])
                            && text(&w["replica"])
                            && ids(&w["frontier"])
                            && ids(&w["opIds"])
                    })
                })
            && value["triggers"].as_array().is_some_and(|triggers| {
                triggers.iter().all(|t| {
                    closed(t, &["kind", "id", "digest", "bytes"])
                        && matches!(t["kind"].as_str(), Some("catalog" | "rotation"))
                        && digest(&t["id"])
                        && digest(&t["digest"])
                        && safe(&t["bytes"])
                })
            }))
}
fn state_valid(value: &Value) -> bool {
    if !closed(
        value,
        &[
            "version",
            "review",
            "histories",
            "catalogs",
            "rotations",
            "cutoffProofs",
            "accepted",
            "blocked",
        ],
    ) || !one(&value["version"])
        || !review_valid(&value["review"])
        || !value["histories"]
            .as_array()
            .is_some_and(|items| items.iter().all(history_valid))
        || !records_valid(&value["catalogs"])
        || !records_valid(&value["rotations"])
        || !value["cutoffProofs"].is_array()
        || !watermark_valid(&value["accepted"])
        || !block_valid(&value["blocked"])
    {
        return false;
    }
    let catalogs = value["catalogs"].as_array().unwrap();
    let rotations = value["rotations"].as_array().unwrap();
    if catalogs.len() + rotations.len() > 1024 {
        return false;
    }
    let mut bytes = 0usize;
    for record in catalogs.iter().chain(rotations) {
        let Some(total) = bytes.checked_add(record["json"].as_str().unwrap().len()) else {
            return false;
        };
        if total > MAX_ARTIFACT_BYTES {
            return false;
        }
        bytes = total;
    }
    true
}
