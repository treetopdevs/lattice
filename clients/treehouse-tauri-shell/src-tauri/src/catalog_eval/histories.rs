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
use std::collections::{BTreeMap, BTreeSet};

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
    pub fn authenticate(raw_histories: &[(&str, &[u8])]) -> Result<Self, HistoryError> {
        let error = |reason| HistoryError {
            reason,
            ids: Vec::new(),
        };
        let mut histories = BTreeMap::new();
        let mut unsupported = false;
        let mut names = BTreeSet::new();
        let mut parsed = Vec::with_capacity(raw_histories.len());
        let mut missing = BTreeSet::new();
        // Raw authentication of the entire set precedes fetch/portability results.
        // Do not run the strict DAG reader yet: authentic depth-65 observation
        // must retain its cutoff refusal rather than becoming a frame error.
        for (name, bytes) in raw_histories {
            let raw = match json::parse_observation(bytes) {
                Ok(raw) => raw,
                Err("observation_limit") => {
                    unsupported = true;
                    continue;
                }
                Err(_) => return Err(error(HISTORY)),
            };
            // An empty history identity is malformed, never repairable (BEAM text?).
            if name.is_empty()
                || !closed_object(&raw, &["replica", "frames", "rejected"])
                || raw["replica"].as_str() != Some(*name)
                || !names.insert(*name)
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
                let rejected =
                    serde_json::json!({"replica":name,"frames":[],"rejected":raw["rejected"]});
                let bytes = serde_json::to_vec(&rejected).map_err(|_| error(HISTORY))?;
                match cutoff::derive(&bytes) {
                    Ok(_) => {}
                    Err(e) if e.reason == "unsupported_cutoff" => unsupported = true,
                    Err(_) => return Err(error(HISTORY)),
                }
            }
            parsed.push((*name, *bytes, raw));
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
        for (name, bytes, raw) in parsed {
            let observation = match cutoff::derive(bytes) {
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
                .map(|frame| serde_json::to_vec(frame).map_err(|_| error(HISTORY)))
                .collect::<Result<_, _>>()?;
            let refs: Vec<&[u8]> = frames.iter().map(Vec::as_slice).collect();
            let dag = AuthenticDag::authenticate(name, &refs)?;
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

// Portability can refuse a representable observation before returning a cutoff.
// Accepted evidence must already have authentic signed content; rejected evidence
// must not relabel an authentic operation as a bad signature. Unrepresentable
// rejected records remain the cutoff owner's unsupported-observation decision.
fn closed_object(value: &serde_json::Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|fields| {
        fields.len() == keys.len() && keys.iter().all(|key| fields.contains_key(*key))
    })
}
fn authenticate_frames(raw: &serde_json::Value) -> Result<BTreeSet<String>, &'static str> {
    let replica = raw["replica"].as_str().ok_or(HISTORY)?;
    let mut ids = BTreeSet::new();
    let mut dependencies = BTreeSet::new();
    for frame in raw["frames"].as_array().ok_or(HISTORY)? {
        let inspected = super::frame::inspect_value(frame).map_err(|_| HISTORY)?;
        if !inspected.authentic() || inspected.replica != replica || !ids.insert(inspected.id) {
            return Err(HISTORY);
        }
        // Match the BEAM owner's text? guard: an empty dependency is malformed
        // evidence, never a repairable missing ID.
        if inspected.deps.iter().any(String::is_empty) {
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
