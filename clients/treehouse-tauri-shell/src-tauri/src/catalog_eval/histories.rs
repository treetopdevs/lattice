//! Immutable authenticated history ownership shared by catalog entries and
//! historical replay. Successful construction validates every supplied history;
//! callers cannot inject a decoded authority result or a saved verdict.
//! This preserves per-history limits only. Origin-first retained validation and
//! aggregate page/snapshot admission still belong to the unfinished resolver.
//! Retaining all parsed histories intentionally increases memory versus a DAG-only
//! fold. The incoming owner must bound that aggregate before exposing this to
//! untrusted pages; this component is not an incoming admission boundary.
use super::{cutoff, history::AuthenticDag, json};
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
    pub fn authenticate(raw_histories: &[(&str, &[u8])]) -> Result<Self, &'static str> {
        let mut histories = BTreeMap::new();
        let mut unsupported = false;
        let mut names = BTreeSet::new();
        // Continue after portability refusal: a later forged history takes priority.
        for (name, bytes) in raw_histories {
            let raw = match json::parse_observation(bytes) {
                Ok(raw) => raw,
                Err("observation_limit") => {
                    unsupported = true;
                    continue;
                }
                Err(_) => return Err(HISTORY),
            };
            if raw["replica"].as_str() != Some(*name) || !names.insert(*name) {
                return Err(HISTORY);
            }
            authenticate_frames(&raw)?;
            let observation = match cutoff::derive(bytes) {
                Ok(observation) => observation,
                Err(error) if error.reason == "unsupported_cutoff" => {
                    unsupported = true;
                    continue;
                }
                Err(_) => return Err(HISTORY),
            };
            if observation.replica() != *name || histories.contains_key(*name) {
                return Err(HISTORY);
            }
            let frames: Vec<Vec<u8>> = raw["frames"]
                .as_array()
                .ok_or(HISTORY)?
                .iter()
                .map(|frame| serde_json::to_vec(frame).map_err(|_| HISTORY))
                .collect::<Result<_, _>>()?;
            let refs: Vec<&[u8]> = frames.iter().map(Vec::as_slice).collect();
            let dag = AuthenticDag::authenticate(name, &refs).map_err(|_| HISTORY)?;
            histories.insert((*name).to_owned(), AuthenticatedHistory { raw, dag });
        }
        if unsupported {
            Err("unsupported_cutoff")
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
fn authenticate_frames(raw: &serde_json::Value) -> Result<(), &'static str> {
    for frame in raw["frames"].as_array().ok_or(HISTORY)? {
        let inspected = super::frame::inspect_value(frame).map_err(|_| HISTORY)?;
        if !inspected.authentic() {
            return Err(HISTORY);
        }
    }
    for rejected in raw["rejected"].as_array().ok_or(HISTORY)? {
        if let Ok(inspected) = super::frame::inspect_value(&rejected["frame"]) {
            if inspected.authentic() {
                return Err(HISTORY);
            }
        }
    }
    Ok(())
}
