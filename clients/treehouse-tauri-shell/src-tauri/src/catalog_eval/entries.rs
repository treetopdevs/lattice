//! Authenticated catalog entry facts. No signer selection, route, freshness or
//! installed trust is established. Every supplied raw history is checked before
//! a missing entry can become pending. This component applies per-history bounds;
//! complete-page/snapshot budgets belong to the unfinished incoming boundary.
//! It is not an IPC boundary.
use super::{
    artifact::Artifact, canonical::Term, cutoff, delegations::Delegation, envelope,
    evidence_terms::*, history::AuthenticDag, json, space_policy::SpacePolicy, thread_policy,
};
use std::collections::{BTreeMap, BTreeSet};

const INVALID: &str = "invalid_catalog_transition";
const HISTORY: &str = "invalid_verified_history";
const PENDING: &str = "trust_pending";

#[derive(Debug)]
pub struct EntryObservation {
    entries: Term,
    bootstrap_id: String,
    bootstrap: Term,
}
impl EntryObservation {
    pub fn entries(&self) -> &Term {
        &self.entries
    }
    pub fn bootstrap_id(&self) -> &str {
        &self.bootstrap_id
    }
    pub fn bootstrap(&self) -> &Term {
        &self.bootstrap
    }
}

pub fn observe(
    artifact: &Artifact,
    raw_histories: &[(&str, &[u8])],
) -> Result<EntryObservation, &'static str> {
    let catalog = field(artifact.term(), "catalog").ok_or("malformed_catalog")?;
    envelope::signing_bytes(catalog).map_err(|_| "malformed_catalog")?;
    let histories = authenticate(raw_histories)?;
    let space_id = text(field(catalog, "space").ok_or(INVALID)?).ok_or(INVALID)?;
    let bootstrap_id = text(field(catalog, "bootstrap").ok_or(INVALID)?).ok_or(INVALID)?;
    let space = histories.get(space_id).ok_or(PENDING)?;
    let bootstrap_op = space.frame(bootstrap_id).ok_or(PENDING)?;
    let space_policy = SpacePolicy::analyze(space).map_err(|_| INVALID)?;
    let bootstrap = match command(bootstrap_op, "catalog_bootstrap_v1") {
        Some([record]) if space_policy.command_reasons().get(bootstrap_id) == Some(&None) => record,
        _ => return Err(INVALID),
    };
    super::bootstrap::Bootstrap::decode(bootstrap).ok_or(INVALID)?;
    let entries = field(catalog, "entries").ok_or(INVALID)?;
    let mut pending = false;
    for entry in list(entries).ok_or(INVALID)? {
        match verify_entry(entry, &histories, space, &space_policy, bootstrap) {
            Ok(()) => {}
            Err(PENDING) => pending = true,
            Err(reason) => return Err(reason),
        }
    }
    if pending {
        return Err(PENDING);
    }
    Ok(EntryObservation {
        entries: entries.clone(),
        bootstrap_id: bootstrap_id.into(),
        bootstrap: bootstrap.clone(),
    })
}

fn authenticate(
    raw_histories: &[(&str, &[u8])],
) -> Result<BTreeMap<String, AuthenticDag>, &'static str> {
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
        histories.insert((*name).to_owned(), dag);
    }
    if unsupported {
        Err("unsupported_cutoff")
    } else {
        Ok(histories)
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

fn verify_entry(
    entry: &Term,
    histories: &BTreeMap<String, AuthenticDag>,
    space: &AuthenticDag,
    space_policy: &SpacePolicy<'_>,
    bootstrap: &Term,
) -> Result<(), &'static str> {
    let get = |name| field(entry, name).ok_or(INVALID);
    let replica = text(get("replica")?).ok_or(INVALID)?;
    let kind = atom(get("kind")?).ok_or(INVALID)?;
    if !super::delegations::bounded_family(replica)
        || !replica.starts_with(&format!("replica:treehouse:{kind}:"))
        || get("service_id")? != field(bootstrap, "service_id").ok_or(INVALID)?
        || get("service_key")? != field(bootstrap, "service_key").ok_or(INVALID)?
    {
        return Err(INVALID);
    }
    let dag = histories.get(replica).ok_or(PENDING)?;
    let genesis_id = text(get("genesis")?).ok_or(INVALID)?;
    let creation_id = text(get("creation")?).ok_or(INVALID)?;
    let genesis = dag.frame(genesis_id).ok_or(PENDING)?;
    let creation = dag.frame(creation_id).ok_or(PENDING)?;
    let root = key(get("root")?).ok_or(INVALID)?;
    let thread_analysis = if kind == "thread" {
        Some(thread_policy::analyze_with_preflight(dag).map_err(|_| INVALID)?)
    } else {
        None
    };
    let (authority, reasons) = match &thread_analysis {
        Some((preflight, reasons)) => (preflight.authority(), reasons),
        None => (
            space_policy.preflight.authority(),
            space_policy.command_reasons(),
        ),
    };
    let genesis_delegation = match genesis.body() {
        Term::Tuple(values) if genesis.kind() == "authority" => match values.as_slice() {
            [tag, delegation, _] if atom(tag) == Some("genesis") => Delegation::decode(delegation),
            _ => None,
        },
        _ => None,
    }
    .ok_or(INVALID)?;
    if authority.static_delegations.root() != Some(root)
        || genesis.author() != root
        || genesis_delegation.issuer != root
        || genesis_delegation.audience != root
        || genesis_delegation.parent.is_some()
        || genesis_delegation.replica != replica
        || !genesis_delegation.self_consistent()
        || authority.reasons().contains_key(genesis_id)
    {
        return Err(INVALID);
    }
    if !matches!(
        command(
            creation,
            if kind == "space" {
                "create_space"
            } else {
                "create_thread"
            }
        ),
        Some([_])
    ) || reasons.get(creation_id) != Some(&None)
        || !dag
            .ancestors(creation_id)
            .is_some_and(|ancestors| ancestors.contains(genesis_id))
    {
        return Err(INVALID);
    }
    if kind == "space" {
        if replica != space.replica()
            || Some(replica) != field(bootstrap, "space").and_then(text)
            || Some(root) != field(bootstrap, "space_root").and_then(key)
        {
            return Err(INVALID);
        }
    } else {
        let reference_id = text(get("reference")?).ok_or(INVALID)?;
        let reference = space.frame(reference_id).ok_or(PENDING)?;
        if !matches!(command(reference, "create_thread"), Some([target, _]) if text(target) == Some(replica))
            || space_policy.command_reasons().get(reference_id) != Some(&None)
        {
            return Err(INVALID);
        }
    }
    Ok(())
}

fn command<'a>(op: &'a super::frame::AuthenticFrame, name: &str) -> Option<&'a [Term]> {
    if op.kind() != "command" {
        return None;
    }
    let Term::Tuple(body) = op.body() else {
        return None;
    };
    let [tag, Term::List(args)] = body.as_slice() else {
        return None;
    };
    (atom(tag) == Some(name)).then_some(args)
}
