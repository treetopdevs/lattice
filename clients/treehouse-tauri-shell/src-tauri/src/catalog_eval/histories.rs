//! Immutable authenticated history ownership shared by catalog entries and
//! historical replay. Successful construction validates every supplied history;
//! callers cannot inject a decoded authority result or a saved verdict.
//! This preserves per-history limits only. Origin-first retained validation and
//! aggregate page/snapshot admission still belong to the unfinished resolver.
//! Retaining all parsed histories intentionally increases memory versus a DAG-only
//! fold. The incoming owner must bound that aggregate before exposing this to
//! untrusted pages; this component is not an incoming admission boundary.
use super::{
    cutoff,
    history::{AuthenticDag, HistoryError},
    json,
    reader::ReadableFrame,
};
use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
};

const HISTORY: &str = "invalid_verified_history";

#[derive(Debug)]
pub struct AuthenticatedHistory {
    raw: serde_json::Value,
    dag: AuthenticDag,
}
impl AuthenticatedHistory {
    /// Original parsed transport values, without semantic normalization. JSON
    /// whitespace, escapes and object order are not retained; this is not an
    /// original-byte/page-digest or storage-origin proof.
    pub fn raw(&self) -> &serde_json::Value {
        &self.raw
    }
    pub fn dag(&self) -> &AuthenticDag {
        &self.dag
    }
}

#[derive(Debug)]
pub struct AuthenticatedHistories {
    histories: BTreeMap<String, AuthenticatedHistory>,
}
impl AuthenticatedHistories {
    /// Authenticate raw history fragments after a first-representation-preserving
    /// union. Neither input is designated trusted. A retained resolver must first
    /// validate its original snapshot independently; this component cannot prove
    /// watermarks, historical witnesses, installed provenance or eligibility.
    pub fn authenticate_union(
        saved: &serde_json::Value,
        incoming: &serde_json::Value,
    ) -> Result<Self, HistoryError> {
        let error = |reason| HistoryError {
            reason,
            ids: Vec::new(),
        };
        let lists = [saved.as_array(), incoming.as_array()];
        let [Some(saved_rows), Some(incoming_rows)] = lists else {
            return Err(error(HISTORY));
        };
        for list in [saved_rows, incoming_rows] {
            for raw in list {
                if !closed_object(raw, &["replica", "frames", "rejected"])
                    || !raw["replica"].as_str().is_some_and(|s| !s.is_empty())
                    || !raw["frames"].is_array()
                    || !raw["rejected"].as_array().is_some_and(|rows| {
                        rows.iter().all(|row| {
                            closed_object(row, &["frame", "reason"])
                                && row["reason"] == "bad_signature"
                        })
                    })
                {
                    return Err(error(HISTORY));
                }
            }
        }
        for list in [saved_rows, incoming_rows] {
            for raw in list {
                let name = raw["replica"].as_str().expect("history shape");
                if !catalog_family(name) {
                    return Err(error("wrong_catalog_scope"));
                }
            }
        }
        for value in [saved, incoming] {
            if !json::within_observation(value, 203) {
                return Err(error(HISTORY));
            }
        }
        // Incoming authenticity and rejected portability precede the merge. An
        // accepted fragment need not be closed or portable until retained union.
        for raw in incoming_rows {
            authenticate_frames(raw).map_err(error)?;
        }
        validate_rejected(incoming_rows)?;
        // Borrow first fragments until ownership is actually needed. A shared
        // family builds its merged rows directly instead of cloning the saved
        // history and then replacing both of its frame arrays.
        let mut union: BTreeMap<&str, Cow<'_, serde_json::Value>> = BTreeMap::new();
        for list in [saved_rows, incoming_rows] {
            let mut seen = BTreeSet::new();
            for raw in list {
                let name = raw["replica"].as_str().expect("history shape");
                if !seen.insert(name) {
                    return Err(error(HISTORY));
                }
                if let Some(prior) = union.get_mut(name) {
                    let frames = merge_frames(
                        prior["frames"].as_array().expect("history shape"),
                        raw["frames"].as_array().expect("history shape"),
                        false,
                    )?;
                    let rejected = merge_frames(
                        prior["rejected"].as_array().expect("history shape"),
                        raw["rejected"].as_array().expect("history shape"),
                        true,
                    )?;
                    *prior = Cow::Owned(serde_json::Value::Object(serde_json::Map::from_iter([
                        ("replica".into(), serde_json::Value::String(name.to_owned())),
                        ("frames".into(), serde_json::Value::Array(frames)),
                        ("rejected".into(), serde_json::Value::Array(rejected)),
                    ])));
                } else {
                    union.insert(name, Cow::Borrowed(raw));
                }
            }
        }
        let merged = serde_json::Value::Array(union.into_values().map(Cow::into_owned).collect());
        if !json::within_observation(&merged, 203) {
            return Err(error(HISTORY));
        }
        let serde_json::Value::Array(merged_rows) = merged else {
            unreachable!("array union")
        };
        let mut observed = Self::authenticate_values(merged_rows, false)?;
        // Source canonicalizes row/frame indexes while preserving each first raw
        // frame object, including its supplied dependency representation.
        for history in observed.histories.values_mut() {
            history.raw["frames"]
                .as_array_mut()
                .unwrap()
                .sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
            history.raw["rejected"]
                .as_array_mut()
                .unwrap()
                .sort_by(|a, b| a["frame"]["id"].as_str().cmp(&b["frame"]["id"].as_str()));
        }
        Ok(observed)
    }

    pub fn authenticate(raw_histories: &[(&str, &[u8])]) -> Result<Self, HistoryError> {
        let error = |reason| HistoryError {
            reason,
            ids: Vec::new(),
        };
        let mut values = Vec::with_capacity(raw_histories.len());
        let mut unsupported = false;
        for (name, bytes) in raw_histories {
            let raw = match json::parse_observation(bytes) {
                Ok(raw) => raw,
                Err("observation_limit") => {
                    unsupported = true;
                    continue;
                }
                Err(_) => return Err(error(HISTORY)),
            };
            if raw["replica"].as_str() != Some(*name) {
                return Err(error(HISTORY));
            }
            values.push(raw);
        }
        Self::authenticate_values(values, unsupported)
    }

    fn authenticate_values(
        values: Vec<serde_json::Value>,
        mut unsupported: bool,
    ) -> Result<Self, HistoryError> {
        let error = |reason| HistoryError {
            reason,
            ids: Vec::new(),
        };
        let mut histories = BTreeMap::new();
        let mut names = BTreeSet::new();
        let mut parsed = Vec::with_capacity(values.len());
        let mut missing = BTreeSet::new();
        // Authenticate the entire union before pending/portable classification.
        for raw in values {
            let name = raw["replica"]
                .as_str()
                .ok_or_else(|| error(HISTORY))?
                .to_owned();
            if !closed_object(&raw, &["replica", "frames", "rejected"])
                || !names.insert(name.clone())
            {
                return Err(error(HISTORY));
            }
            missing.extend(authenticate_frames(&raw).map_err(error)?);
            // Rejected evidence has its own portability stage before fetching,
            // just like the public owners' empty-accepted cutoff observation.
            if !raw["rejected"]
                .as_array()
                .expect("authenticated shape")
                .is_empty()
            {
                match rejected_portability(&raw) {
                    Ok(_) => {}
                    Err(e) if e.reason == "unsupported_cutoff" => unsupported = true,
                    Err(_) => return Err(error(HISTORY)),
                }
            }
            parsed.push((name, raw));
        }
        if unsupported {
            return Err(error("unsupported_cutoff"));
        }
        if !missing.is_empty() {
            return Err(HistoryError {
                reason: "trust_pending",
                ids: missing.into_iter().collect(),
            });
        }
        // Only complete evidence reaches the unchanged closed cutoff primitive.
        for (name, raw) in parsed {
            let observation = match cutoff::derive_value(&raw) {
                Ok(observation) => observation,
                Err(cutoff_error) if cutoff_error.reason == "unsupported_cutoff" => {
                    unsupported = true;
                    continue;
                }
                Err(_) => return Err(error(HISTORY)),
            };
            if observation.replica() != name {
                return Err(error(HISTORY));
            }
            let frames: Vec<Vec<u8>> = raw["frames"]
                .as_array()
                .ok_or_else(|| error(HISTORY))?
                .iter()
                .map(|frame| {
                    let view = super::raw_numbers::frame_view(frame).map_err(|_| error(HISTORY))?;
                    serde_json::to_vec(view.as_ref()).map_err(|_| error(HISTORY))
                })
                .collect::<Result<_, _>>()?;
            let refs: Vec<&[u8]> = frames.iter().map(Vec::as_slice).collect();
            let dag = AuthenticDag::authenticate_accounted(&name, &refs)?;
            let mut readable = true;
            for frame in &frames {
                match ReadableFrame::verify(frame) {
                    Ok(_) => {}
                    Err("unsupported_cutoff") => {
                        unsupported = true;
                        readable = false;
                    }
                    Err(_) => return Err(error(HISTORY)),
                }
            }
            if readable {
                histories.insert(name.to_owned(), AuthenticatedHistory { raw, dag });
            }
        }
        if unsupported {
            Err(error("unsupported_cutoff"))
        } else {
            Ok(Self { histories })
        }
    }
    pub fn get(&self, replica: &str) -> Option<&AuthenticatedHistory> {
        self.histories.get(replica)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&str, &AuthenticatedHistory)> {
        self.histories
            .iter()
            .map(|(name, history)| (name.as_str(), history))
    }
}

fn rejected_portability(raw: &serde_json::Value) -> Result<(), cutoff::CutoffError> {
    let rejected =
        serde_json::json!({"replica":raw["replica"],"frames":[],"rejected":raw["rejected"]});
    cutoff::derive_value(&rejected).map(|_| ())
}

fn validate_rejected(rows: &[serde_json::Value]) -> Result<(), HistoryError> {
    let mut unsupported = false;
    for raw in rows {
        match rejected_portability(raw) {
            Ok(_) => {}
            Err(error) if error.reason == "unsupported_cutoff" => unsupported = true,
            Err(_) => {
                return Err(HistoryError {
                    reason: HISTORY,
                    ids: Vec::new(),
                })
            }
        }
    }
    if unsupported {
        Err(HistoryError {
            reason: "unsupported_cutoff",
            ids: Vec::new(),
        })
    } else {
        Ok(())
    }
}

fn merge_frames(
    saved: &[serde_json::Value],
    incoming: &[serde_json::Value],
    rejected: bool,
) -> Result<Vec<serde_json::Value>, HistoryError> {
    let mut merged: BTreeMap<&str, &serde_json::Value> = BTreeMap::new();
    fn frame(value: &serde_json::Value, rejected: bool) -> &serde_json::Value {
        if rejected {
            &value["frame"]
        } else {
            value
        }
    }
    for list in [saved, incoming] {
        let mut seen = BTreeSet::new();
        for item in list {
            let raw = frame(item, rejected);
            let id = raw["id"].as_str().ok_or_else(|| HistoryError {
                reason: HISTORY,
                ids: Vec::new(),
            })?;
            if !seen.insert(id) {
                return Err(HistoryError {
                    reason: HISTORY,
                    ids: Vec::new(),
                });
            }
            if let Some(prior) = merged.get(id) {
                let fingerprint = |raw| {
                    super::frame::inspect_value(raw)
                        .map(|proof| (proof.payload, raw["sig"].clone()))
                };
                if !matches!((fingerprint(frame(prior, rejected)), fingerprint(raw)), (Ok(a), Ok(b)) if a == b)
                {
                    return Err(HistoryError {
                        reason: HISTORY,
                        ids: vec![id.to_owned()],
                    });
                }
            } else {
                merged.insert(id, item);
            }
        }
    }
    Ok(merged.into_values().cloned().collect())
}

pub(super) fn catalog_family(name: &str) -> bool {
    super::delegations::bounded_family(name)
        && (name.starts_with("replica:treehouse:space:")
            || name.starts_with("replica:treehouse:thread:"))
}

// Portability can refuse a representable observation before returning a cutoff.
// Accepted evidence must already have authentic signed content; rejected evidence
// must not relabel an authentic operation as a bad signature. Unrepresentable
// rejected records remain the cutoff owner's unsupported-observation decision.
fn closed_object(value: &serde_json::Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|fields| {
        fields.len() == keys.len() && keys.iter().all(|key| fields.contains_key(*key))
    })
}
// Shared authenticity-only stage for incoming fragments. A missing dependency
// is an observation, not a portability/closure verdict before retained union.
pub(super) fn authenticate_frames(
    raw: &serde_json::Value,
) -> Result<BTreeSet<String>, &'static str> {
    let replica = raw["replica"].as_str().ok_or(HISTORY)?;
    let mut ids = BTreeSet::new();
    let mut dependencies = BTreeSet::new();
    for frame in raw["frames"].as_array().ok_or(HISTORY)? {
        let inspected = super::frame::inspect_value(frame).map_err(|_| HISTORY)?;
        if !inspected.authentic() || inspected.replica != replica || !ids.insert(inspected.id) {
            return Err(HISTORY);
        }
        dependencies.extend(inspected.deps);
    }
    let mut rejected_ids = BTreeSet::new();
    for rejected in raw["rejected"].as_array().ok_or(HISTORY)? {
        if !closed_object(rejected, &["frame", "reason"])
            || rejected["reason"] != "bad_signature"
            || rejected["frame"]["replica"].as_str() != Some(replica)
        {
            return Err(HISTORY);
        }
        let id = rejected["frame"]["id"].as_str().ok_or(HISTORY)?;
        if !rejected_ids.insert(id) {
            return Err(HISTORY);
        }
        if let Ok(inspected) = super::frame::inspect_value(&rejected["frame"]) {
            if inspected.authentic() {
                return Err(HISTORY);
            }
        }
    }
    Ok(dependencies.difference(&ids).cloned().collect())
}
