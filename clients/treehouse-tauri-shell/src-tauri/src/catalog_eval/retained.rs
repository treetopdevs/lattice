//! Internal retained-fold integration. No public evaluator, IPC or installation
//! entry point exists until original-state and historical witness replay close.
use super::{
    artifact::Artifact,
    chains::{self, ChainError, ChainObservation},
    entries::BootstrapObservation,
    evidence_terms::*,
    rotation,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct Graph {
    pub(super) links: ChainObservation,
    pub(super) catalog_pending: BTreeMap<String, BTreeSet<String>>,
    pub(super) binding_pending: BTreeMap<String, BTreeSet<String>>,
    required_cutoffs: BTreeMap<String, Vec<Value>>,
}

impl Graph {
    /// Join entry proof during iterative graph resolution. Saved diagnostic
    /// exceptions are derived here from the original inventory/support closure;
    /// the caller cannot supply an honor/complete flag for individual entries.
    pub(super) fn observe(
        bootstrap: &BootstrapObservation<'_>,
        catalogs: &[Artifact],
        rotations: &[Artifact],
        original: &Value,
    ) -> Result<Self, ChainError> {
        let fail = |reason, ids| ChainError { reason, ids };
        validate_original_artifact_ids(original)?;
        // Reclassify accepted evidence from the actual union before candidates;
        // source output is never an input to native authority classification.
        let mut refused = bootstrap.current_refusal().is_some();
        if let Some(accepted) = original["accepted"]["catalog"].as_str() {
            let saved = original["catalogs"]
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["id"].as_str() == Some(accepted)))
                .ok_or_else(|| fail("trust_recovery_required", Vec::new()))?;
            let artifact = super::artifact::parse(
                saved["json"]
                    .as_str()
                    .ok_or_else(|| fail("trust_recovery_required", Vec::new()))?
                    .as_bytes(),
            )
            .map_err(|_| fail("trust_recovery_required", Vec::new()))?;
            let catalog = field(artifact.term(), "catalog")
                .ok_or_else(|| fail("trust_recovery_required", Vec::new()))?;
            if digest("lattice-treehouse-transport-catalog-v1", catalog).as_deref()
                != Some(accepted)
            {
                return Err(fail("trust_recovery_required", Vec::new()));
            }
            for fact in bootstrap
                .entry_facts(&artifact)
                .map_err(|_| fail("trust_recovery_required", Vec::new()))?
            {
                if fact.invalid() || !fact.pending().is_empty() {
                    return Err(fail("trust_recovery_required", Vec::new()));
                }
                refused |= !fact.refused().is_empty();
            }
        }
        let authority_changed = refused || original["blocked"]["reason"] == "authority_changed";
        let mut by_catalog = BTreeMap::new();
        for artifact in catalogs {
            let catalog = field(artifact.term(), "catalog")
                .ok_or_else(|| fail("malformed_catalog", Vec::new()))?;
            let id = digest("lattice-treehouse-transport-catalog-v1", catalog)
                .ok_or_else(|| fail("malformed_catalog", Vec::new()))?;
            by_catalog.entry(id).or_insert(artifact);
        }
        let mut by_rotation = BTreeMap::new();
        for artifact in rotations {
            let node = rotation::Envelope::decode(artifact.term())
                .ok_or_else(|| fail("malformed_catalog", Vec::new()))?;
            by_rotation
                .entry(
                    node.id()
                        .ok_or_else(|| fail("malformed_catalog", Vec::new()))?,
                )
                .or_insert(node);
        }
        let mut accepted = BTreeSet::new();
        let mut bindings = BTreeSet::new();
        let mut pending_catalogs = original["accepted"]["catalog"]
            .as_str()
            .map(String::from)
            .into_iter()
            .collect::<Vec<_>>();
        let mut pending_bindings = original["accepted"]["binding"]
            .as_str()
            .map(String::from)
            .into_iter()
            .collect::<Vec<_>>();
        while !pending_catalogs.is_empty() || !pending_bindings.is_empty() {
            if let Some(id) = pending_catalogs.pop() {
                if accepted.insert(id.clone()) {
                    let artifact = by_catalog
                        .get(&id)
                        .ok_or_else(|| fail("trust_recovery_required", Vec::new()))?;
                    let c = field(artifact.term(), "catalog").unwrap();
                    pending_bindings.push(
                        field(c, "binding")
                            .and_then(text)
                            .ok_or_else(|| fail("malformed_catalog", Vec::new()))?
                            .into(),
                    );
                    if let Some(previous) = field(c, "previous").and_then(text) {
                        pending_catalogs.push(previous.into());
                    }
                }
            }
            if let Some(id) = pending_bindings.pop() {
                if id != bootstrap.id() && bindings.insert(id.clone()) {
                    let node = by_rotation
                        .get(&id)
                        .ok_or_else(|| fail("trust_recovery_required", Vec::new()))?;
                    pending_bindings.push(node.rotation.parent.into());
                    pending_catalogs.push(node.rotation.prior_catalog.into());
                }
            }
        }
        let retained: BTreeSet<_> = original["catalogs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| row["id"].as_str())
            .collect();
        let mut catalog_pending = BTreeMap::<String, BTreeSet<String>>::new();
        let links = chains::observe_with_entries(bootstrap, catalogs, rotations, |id, catalog| {
            let artifact = by_catalog.get(id).expect("parsed graph catalog");
            let diagnostic =
                !original["blocked"].is_null() && !accepted.contains(id) && retained.contains(id);
            let facts = bootstrap
                .entry_facts(artifact)
                .map_err(|reason| fail(reason, Vec::new()))?;
            let entries = list(field(catalog, "entries").unwrap()).unwrap();
            let mut pending = BTreeSet::new();
            for (entry, fact) in entries.iter().zip(facts) {
                if (fact.invalid() && !diagnostic)
                    || (!fact.refused().is_empty() && !authority_changed && !diagnostic)
                {
                    let ids = std::iter::once(id.to_owned())
                        .chain(fact.refused().iter().cloned())
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .collect();
                    return Err(fail("invalid_catalog_transition", ids));
                }
                if fact.invalid() {
                    pending.extend(
                        ["genesis", "creation", "reference"]
                            .map(|name| field(entry, name).and_then(text).unwrap().to_owned()),
                    );
                }
                if diagnostic {
                    pending.extend(fact.refused().iter().cloned());
                }
                pending.extend(fact.pending().iter().cloned());
            }
            catalog_pending.insert(id.into(), pending);
            Ok(())
        })?;
        let mut binding_pending = BTreeMap::<String, BTreeSet<String>>::new();
        let mut ordered: Vec<_> = links.bindings.iter().collect();
        ordered.sort_by_key(|(_, node)| node.generation);
        for (id, binding) in ordered {
            let mut pending = BTreeSet::new();
            if let Some(parent) = &binding.parent {
                pending.extend(
                    catalog_pending[binding.prior.as_ref().unwrap()]
                        .iter()
                        .cloned(),
                );
                pending.extend(binding_pending[parent].iter().cloned());
            }
            binding_pending.insert(id.clone(), pending);
        }
        Ok(Self {
            links,
            catalog_pending,
            binding_pending,
            required_cutoffs: by_rotation.into_iter().map(|(id,node)| (id,node.rotation.cutoffs.into_iter().map(|cutoff| {
                serde_json::json!({"replica":cutoff.replica,"frontier":cutoff.frontier,"logDigest":cutoff.log_digest})
            }).collect())).collect(),
        })
    }
    pub(super) fn complete_cutoffs(&mut self, proofs: &Proofs) {
        for (id, cutoffs) in &self.required_cutoffs {
            let pending = self
                .binding_pending
                .get_mut(id)
                .expect("owned resolved binding");
            for cutoff in cutoffs {
                if !proofs.rows.iter().any(|proof| &proof["cutoff"] == cutoff) {
                    pending.insert(
                        cutoff["logDigest"]
                            .as_str()
                            .expect("owned cutoff digest")
                            .into(),
                    );
                }
            }
        }
        let mut ordered: Vec<_> = self.links.bindings.iter().collect();
        ordered.sort_by_key(|(_, node)| node.generation);
        for (id, binding) in ordered {
            if let Some(parent) = &binding.parent {
                let parent_pending = self.binding_pending[parent].clone();
                self.binding_pending
                    .get_mut(id)
                    .unwrap()
                    .extend(parent_pending);
            }
        }
    }
}

/// Only this owner constructs proof membership from actual raw history evidence.
/// A matching digest string supplied by a caller is not a verified cutoff.
pub(super) struct Proofs {
    rows: Vec<Value>,
}
impl Proofs {
    pub(super) fn observe(
        saved: &[Value],
        incoming: &[Value],
        histories: &super::histories::AuthenticatedHistories,
    ) -> Result<Self, ChainError> {
        let fail = |reason, ids| ChainError { reason, ids };
        let mut proofs = BTreeMap::new();
        let mut members = BTreeMap::new();
        for proof in saved.iter().chain(incoming) {
            if !closed_json(proof, &["cutoff", "history"]) || !valid_cutoff(&proof["cutoff"]) {
                return Err(fail("malformed_catalog", Vec::new()));
            }
            let raw = &proof["history"];
            let name = raw["replica"].as_str().unwrap_or("");
            if !super::delegations::bounded_family(name)
                || !(name.starts_with("replica:treehouse:space:")
                    || name.starts_with("replica:treehouse:thread:"))
                || !super::json::within_observation(raw, 203)
            {
                return Err(fail("recovery_incomplete", Vec::new()));
            }
            let observed = super::cutoff::derive_value(raw)
                .map_err(|_| fail("recovery_incomplete", Vec::new()))?;
            let claimed = &proof["cutoff"];
            let ids = vec![claimed["logDigest"].as_str().unwrap().to_owned()];
            if claimed
                != &serde_json::json!({"replica":observed.replica(),"frontier":observed.frontier(),"logDigest":observed.log_digest()})
            {
                return Err(fail("recovery_incomplete", ids));
            }
            if !members.contains_key(name) {
                let current = histories
                    .get(name)
                    .ok_or_else(|| fail("recovery_incomplete", ids.clone()))?
                    .raw();
                let accepted = current["frames"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(fingerprint)
                    .collect::<Result<BTreeSet<_>, _>>()?;
                let rejected = current["rejected"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|row| fingerprint(&row["frame"]))
                    .collect::<Result<BTreeSet<_>, _>>()?;
                members.insert(name.to_owned(), (accepted, rejected));
            }
            let (accepted, rejected) = members
                .get(name)
                .ok_or_else(|| fail("recovery_incomplete", ids.clone()))?;
            for (items, members, rejected_records) in [
                (&raw["frames"], accepted, false),
                (&raw["rejected"], rejected, true),
            ] {
                for item in items.as_array().expect("derived history") {
                    let frame = if rejected_records {
                        &item["frame"]
                    } else {
                        item
                    };
                    if !members.contains(
                        &fingerprint(frame)
                            .map_err(|_| fail("recovery_incomplete", ids.clone()))?,
                    ) {
                        return Err(fail("recovery_incomplete", ids));
                    }
                }
            }
            let key = format!("{}:{}", observed.replica(), observed.log_digest());
            proofs.entry(key).or_insert_with(|| proof.clone());
        }
        Ok(Self {
            rows: proofs.into_values().collect(),
        })
    }
}
fn closed_json(value: &Value, names: &[&str]) -> bool {
    value.as_object().is_some_and(|map| {
        map.len() == names.len() && names.iter().all(|name| map.contains_key(*name))
    })
}
fn valid_cutoff(value: &Value) -> bool {
    closed_json(value, &["replica", "frontier", "logDigest"])
        && value["replica"].as_str().is_some_and(|s| !s.is_empty())
        && value["logDigest"]
            .as_str()
            .is_some_and(|s| super::frame::identifier(s).is_ok())
        && value["frontier"].as_array().is_some_and(|rows| {
            rows.iter().all(|v| {
                v.as_str()
                    .is_some_and(|s| super::frame::identifier(s).is_ok())
            }) && rows.windows(2).all(|p| p[0].as_str() < p[1].as_str())
        })
}
fn fingerprint(frame: &Value) -> Result<(String, [u8; 32], String), ChainError> {
    let inspected = super::frame::inspect_value(frame).map_err(|_| ChainError {
        reason: "invalid_verified_history",
        ids: Vec::new(),
    })?;
    Ok((
        inspected.id,
        Sha256::digest(&inspected.payload).into(),
        frame["sig"].as_str().unwrap().into(),
    ))
}

/// Original-only evidence, still awaiting complete graph/watermark/block
/// validation. Its constructor accepts no candidate origin. Witness replay cannot
/// accidentally consume the later incoming union through this interface.
struct OriginalEvidence {
    snapshot: super::snapshot::UnverifiedSnapshot,
    histories: super::histories::AuthenticatedHistories,
}
impl OriginalEvidence {
    fn read(bytes: &[u8]) -> Result<Self, ChainError> {
        let recovery = || ChainError {
            reason: "trust_recovery_required",
            ids: Vec::new(),
        };
        let snapshot = super::snapshot::UnverifiedSnapshot::parse(bytes).map_err(|_| recovery())?;
        validate_original_artifact_ids(snapshot.raw())?;
        let histories = super::histories::AuthenticatedHistories::authenticate_union(
            &snapshot.raw()["histories"],
            &serde_json::json!([]),
        )
        .map_err(|_| recovery())?;
        Ok(Self {
            snapshot,
            histories,
        })
    }
    fn validate_authority_witnesses(&self) -> Result<(), ChainError> {
        let original = self.snapshot.raw();
        let histories = &self.histories;
        let recovery = || ChainError {
            reason: "trust_recovery_required",
            ids: Vec::new(),
        };
        let block = &original["blocked"];
        let witnesses = block["authorityWitnesses"]
            .as_array()
            .ok_or_else(recovery)?;
        let mut replicas = BTreeSet::new();
        let mut witness_ids = BTreeSet::new();
        let mut last_replica = None;
        if witnesses.is_empty() {
            return Err(recovery());
        }
        let space = original["review"]["space"].as_str().ok_or_else(recovery)?;
        let selected = original["review"]["bootstrapId"]
            .as_str()
            .ok_or_else(recovery)?;
        let mut allowed =
            BTreeMap::from([(space.to_owned(), BTreeSet::from([selected.to_owned()]))]);
        if let Some(accepted) = original["accepted"]["catalog"].as_str() {
            let saved = original["catalogs"]
                .as_array()
                .ok_or_else(recovery)?
                .iter()
                .find(|row| row["id"].as_str() == Some(accepted))
                .ok_or_else(recovery)?;
            let artifact =
                super::artifact::parse(saved["json"].as_str().ok_or_else(recovery)?.as_bytes())
                    .map_err(|_| recovery())?;
            let catalog = field(artifact.term(), "catalog").ok_or_else(recovery)?;
            super::envelope::signing_bytes(catalog).map_err(|_| recovery())?;
            if digest("lattice-treehouse-transport-catalog-v1", catalog).as_deref()
                != Some(accepted)
            {
                return Err(recovery());
            }
            for entry in
                list(field(catalog, "entries").ok_or_else(recovery)?).ok_or_else(recovery)?
            {
                let replica = field(entry, "replica")
                    .and_then(text)
                    .ok_or_else(recovery)?;
                allowed.entry(replica.into()).or_default().extend(
                    ["genesis", "creation"]
                        .map(|name| field(entry, name).and_then(text).unwrap().to_owned()),
                );
                allowed.get_mut(space).unwrap().insert(
                    field(entry, "reference")
                        .and_then(text)
                        .ok_or_else(recovery)?
                        .into(),
                );
            }
        }
        for witness in witnesses {
            let replica = witness["replica"].as_str().ok_or_else(recovery)?;
            if !replicas.insert(replica) || last_replica.is_some_and(|prior| prior >= replica) {
                return Err(recovery());
            }
            last_replica = Some(replica);
            let ids = canonical_strings(&witness["opIds"]).ok_or_else(recovery)?;
            let frontier = canonical_strings(&witness["frontier"]).ok_or_else(recovery)?;
            let history = histories.get(replica).ok_or_else(recovery)?;
            if ids.is_empty()
                || frontier.is_empty()
                || ids.len() > history.dag().order().len()
                || frontier.len() > history.dag().order().len()
                || ids
                    .iter()
                    .any(|id| !allowed.get(replica).is_some_and(|set| set.contains(id)))
            {
                return Err(recovery());
            }
            let slice = history.dag().causal_slice(&frontier).ok_or_else(recovery)?;
            if slice.frontier() != frontier {
                return Err(recovery());
            }
            let refused: BTreeSet<String> = if replica.starts_with("replica:treehouse:space:") {
                let policy =
                    super::space_policy::SpacePolicy::analyze(&slice).map_err(|_| recovery())?;
                policy
                    .preflight
                    .authority()
                    .reasons()
                    .keys()
                    .cloned()
                    .chain(
                        policy
                            .command_reasons()
                            .iter()
                            .filter(|(_, reason)| reason.is_some())
                            .map(|(id, _)| id.clone()),
                    )
                    .collect()
            } else {
                let (preflight, reasons) =
                    super::thread_policy::analyze_with_preflight(&slice).map_err(|_| recovery())?;
                preflight
                    .authority()
                    .reasons()
                    .keys()
                    .cloned()
                    .chain(
                        reasons
                            .iter()
                            .filter(|(_, reason)| reason.is_some())
                            .map(|(id, _)| id.clone()),
                    )
                    .collect()
            };
            if ids.iter().any(|id| !refused.contains(id)) {
                return Err(recovery());
            }
            witness_ids.extend(ids);
        }
        if canonical_strings(&block["opIds"]).ok_or_else(recovery)?
            != witness_ids.into_iter().collect::<Vec<_>>()
        {
            return Err(recovery());
        }
        Ok(())
    }
}
// A saved row label cannot supply diagnostic membership without matching its
// owned artifact. Signatures, graph support and watermarks remain later checks.
fn validate_original_artifact_ids(original: &Value) -> Result<(), ChainError> {
    let recovery = || ChainError {
        reason: "trust_recovery_required",
        ids: Vec::new(),
    };
    for (name, rotation) in [("catalogs", false), ("rotations", true)] {
        for row in original[name].as_array().ok_or_else(recovery)? {
            let artifact =
                super::artifact::parse(row["json"].as_str().ok_or_else(recovery)?.as_bytes())
                    .map_err(|_| recovery())?;
            let actual = if rotation {
                rotation::Envelope::decode(artifact.term())
                    .and_then(|node| node.id())
                    .ok_or_else(recovery)?
            } else {
                let catalog = field(artifact.term(), "catalog").ok_or_else(recovery)?;
                super::envelope::signing_bytes(catalog).map_err(|_| recovery())?;
                digest("lattice-treehouse-transport-catalog-v1", catalog).ok_or_else(recovery)?
            };
            if row["id"].as_str() != Some(actual.as_str()) {
                return Err(recovery());
            }
        }
    }
    Ok(())
}
fn canonical_strings(value: &Value) -> Option<Vec<String>> {
    let ids = value
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(String::from))
        .collect::<Option<Vec<_>>>()?;
    ids.windows(2).all(|pair| pair[0] < pair[1]).then_some(ids)
}

#[cfg(test)]
#[path = "../../tests/support/catalog_peer.rs"]
mod catalog_peer;
#[cfg(test)]
mod tests {
    use super::super::histories::AuthenticatedHistories;
    use super::*;
    use serde_json::json;

    #[test]
    fn integrated_graph_entry_and_cutoff_stages_match_fresh_full_source_requests() {
        for (mode, count) in [("resolver-produce", 11), ("witness-produce", 14)] {
            let table: Value =
                serde_json::from_slice(&catalog_peer::output("ts", mode, None, 32 * 1024 * 1024))
                    .unwrap();
            assert_eq!(table["cases"].as_array().unwrap().len(), count);
            let mut compared = 0;
            for case in table["cases"].as_array().unwrap() {
                for row in case["orders"].as_array().unwrap() {
                    let decision = &row["decision"];
                    if decision["kind"] == "reject"
                        && case["name"] != "available-invalid-before-missing"
                    {
                        continue;
                    }
                    let input = &row["input"];
                    let original = &input["installed"];
                    let incoming = &input["incoming"];
                    let histories = AuthenticatedHistories::authenticate_union(
                        &original["histories"],
                        &incoming["histories"],
                    )
                    .unwrap();
                    let bootstrap = BootstrapObservation::observe(
                        &histories,
                        original["review"]["space"].as_str().unwrap(),
                        original["review"]["bootstrapId"].as_str().unwrap(),
                    )
                    .unwrap();
                    let parse = |name: &str| {
                        original[name]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| v["json"].as_str().unwrap())
                            .chain(
                                incoming[name]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .map(|v| v.as_str().unwrap()),
                            )
                            .map(|s| super::super::artifact::parse(s.as_bytes()).unwrap())
                            .collect::<Vec<_>>()
                    };
                    let catalogs = parse("catalogs");
                    let rotations = parse("rotations");
                    let graph_result = Graph::observe(&bootstrap, &catalogs, &rotations, original);
                    if decision["kind"] == "reject" {
                        let error = match graph_result {
                            Ok(_) => panic!("invalid entry accepted"),
                            Err(error) => error,
                        };
                        assert_eq!(
                            error.reason,
                            decision["reason"].as_str().unwrap(),
                            "{}",
                            case["name"]
                        );
                        assert_eq!(
                            json!(error.ids),
                            decision["detail"]["ids"],
                            "{}",
                            case["name"]
                        );
                        continue;
                    }
                    let mut graph =
                        graph_result.unwrap_or_else(|error| panic!("{}: {error:?}", case["name"]));
                    if !original["catalogs"].as_array().unwrap().is_empty() {
                        let mut mislabeled = original.clone();
                        mislabeled["catalogs"][0]["id"] = original["review"]["bootstrapId"].clone();
                        let error =
                            match Graph::observe(&bootstrap, &catalogs, &rotations, &mislabeled) {
                                Ok(_) => {
                                    panic!("unchecked saved label supplied diagnostic membership")
                                }
                                Err(error) => error,
                            };
                        assert_eq!(error.reason, "trust_recovery_required");
                    }
                    let proofs = Proofs::observe(
                        original["cutoffProofs"].as_array().unwrap(),
                        incoming["cutoffProofs"].as_array().unwrap(),
                        &histories,
                    )
                    .unwrap();
                    graph.complete_cutoffs(&proofs);
                    if case["name"] == "genuine-pending-entry" {
                        let entry = catalogs
                            .iter()
                            .filter_map(|a| field(a.term(), "catalog"))
                            .flat_map(|c| list(field(c, "entries").unwrap()).unwrap())
                            .find(|e| field(e, "kind").and_then(atom) == Some("thread"))
                            .unwrap();
                        let expected: BTreeSet<String> = ["genesis", "creation", "reference"]
                            .map(|name| field(entry, name).and_then(text).unwrap().into())
                            .into();
                        assert_eq!(expected.len(), 3);
                        assert_eq!(
                            graph
                                .catalog_pending
                                .values()
                                .find(|ids| !ids.is_empty())
                                .unwrap(),
                            &expected
                        );
                        assert_eq!(decision["reason"], "trust_pending");
                    }
                    if case["name"] == "rotation-missing-proof"
                        || case["name"] == "rotation-descendant-missing-proof"
                    {
                        let expected: BTreeSet<String> = rotations
                            .iter()
                            .flat_map(|artifact| {
                                rotation::Envelope::decode(artifact.term())
                                    .unwrap()
                                    .rotation
                                    .cutoffs
                                    .into_iter()
                                    .map(|c| c.log_digest.to_owned())
                            })
                            .collect();
                        assert_eq!(expected.len(), if rotations.len() == 2 { 4 } else { 2 });
                        let head = &graph.links.binding_heads[0];
                        assert_eq!(graph.binding_pending[head], expected, "{}", case["name"]);
                        assert_eq!(decision["reason"], "recovery_incomplete");
                    }

                    assert_eq!(
                        json!(graph.links.binding_heads),
                        decision["observed"]["bindingHeads"],
                        "{}",
                        case["name"]
                    );
                    let heads: Vec<_> = graph
                        .links
                        .catalog_heads
                        .iter()
                        .map(|(binding, catalogs)| json!({"binding":binding,"catalogs":catalogs}))
                        .collect();
                    assert_eq!(
                        json!(heads),
                        decision["observed"]["catalogHeads"],
                        "{}",
                        case["name"]
                    );
                    assert_eq!(
                        json!(proofs.rows),
                        decision["next"]["cutoffProofs"],
                        "{}",
                        case["name"]
                    );
                    if !decision["next"]["accepted"].is_null()
                        && decision["next"]["blocked"].is_null()
                        && decision["reason"].is_null()
                    {
                        let watermark = &decision["next"]["accepted"];
                        assert!(
                            graph.catalog_pending[watermark["catalog"].as_str().unwrap()]
                                .is_empty()
                        );
                        assert!(
                            graph.binding_pending[watermark["binding"].as_str().unwrap()]
                                .is_empty()
                        );
                    }
                    compared += 1;
                }
            }
            assert!(
                compared >= 4,
                "{mode} has insufficient positive graph coverage"
            );
        }
    }
    #[test]
    fn original_authority_witnesses_replay_historical_refusal_after_real_current_rehonor() {
        let table: Value = serde_json::from_slice(&catalog_peer::output(
            "ts",
            "witness-produce",
            None,
            32 * 1024 * 1024,
        ))
        .unwrap();
        let mut valid = 0;
        let mut rejected = 0;
        for case in table["cases"].as_array().unwrap() {
            for row in case["orders"].as_array().unwrap() {
                let original = &row["input"]["installed"];
                if original["blocked"]["reason"] != "authority_changed" {
                    continue;
                }
                let result = OriginalEvidence::read(&serde_json::to_vec(original).unwrap())
                    .and_then(|owner| owner.validate_authority_witnesses());
                if row["decision"]["kind"] == "reject" {
                    assert_eq!(
                        result.unwrap_err().reason,
                        "trust_recovery_required",
                        "{}",
                        case["name"]
                    );
                    rejected += 1;
                } else {
                    result.unwrap_or_else(|error| panic!("{}: {error:?}", case["name"]));
                    if !original["accepted"].is_null() {
                        let mut missing = original.clone();
                        missing["catalogs"] = json!([]);
                        let error = OriginalEvidence::read(&serde_json::to_vec(&missing).unwrap())
                            .and_then(|owner| owner.validate_authority_witnesses())
                            .unwrap_err();
                        assert_eq!(error.reason, "trust_recovery_required");
                    }
                    valid += 1;
                }
            }
        }
        assert!(
            valid >= 6,
            "historical freeze/reopen/re-honor controls missing"
        );
        assert!(rejected >= 14, "false witness controls missing");
    }
    #[test]
    fn original_witness_catalog_schema_failure_requires_recovery_without_panicking() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let table: Value = serde_json::from_slice(&catalog_peer::output(
            "ts",
            "witness-produce",
            None,
            32 * 1024 * 1024,
        ))
        .unwrap();
        let original = table["cases"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|case| case["orders"].as_array().unwrap())
            .map(|row| &row["input"]["installed"])
            .find(|original| {
                original["blocked"]["reason"] == "authority_changed"
                    && !original["accepted"].is_null()
            })
            .unwrap();
        let mut original = original.clone();
        let malformed = json!([
            "map",
            [[
                ["atom", "catalog"],
                [
                    "map",
                    [[
                        ["atom", "entries"],
                        [
                            "list",
                            [[
                                "map",
                                [[
                                    ["atom", "replica"],
                                    [
                                        "bin",
                                        STANDARD
                                            .encode(original["review"]["space"].as_str().unwrap())
                                    ]
                                ]]
                            ]]
                        ]
                    ]]
                ]
            ]]
        ]);
        let bytes = serde_json::to_vec(&malformed).unwrap();
        let artifact = super::super::artifact::parse(&bytes).unwrap();
        let id = digest(
            "lattice-treehouse-transport-catalog-v1",
            field(artifact.term(), "catalog").unwrap(),
        )
        .unwrap();
        original["catalogs"] = json!([{"id":id,"json":String::from_utf8(bytes).unwrap()}]);
        original["accepted"]["catalog"] = json!(id);
        let error = OriginalEvidence::read(&serde_json::to_vec(&original).unwrap())
            .and_then(|owner| owner.validate_authority_witnesses())
            .unwrap_err();
        assert_eq!(error.reason, "trust_recovery_required");
    }
}
