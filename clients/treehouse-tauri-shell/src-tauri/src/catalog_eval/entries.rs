//! Authenticated catalog entry facts. No signer selection, route, freshness or
//! installed trust is established. Every supplied raw history is checked before
//! a missing entry can become pending. This component applies per-history bounds;
//! complete-page/snapshot budgets belong to the unfinished incoming boundary.
//! It is not an IPC boundary.
use super::{
    artifact::Artifact, canonical::Term, delegations::Delegation, envelope, evidence_terms::*,
    histories::AuthenticatedHistories, history::AuthenticDag, space_policy::SpacePolicy,
    thread_policy,
};

const INVALID: &str = "invalid_catalog_transition";
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

/// An authenticated bootstrap command, independent of current policy and catalog
/// entry completeness. This does not select a reviewed pin, check the observed
/// bootstrap inventory, validate retained state, or authorize any route.
/// The borrowed DAG keeps the authentic source and policy alive and immutable.
pub struct BootstrapObservation<'a> {
    histories: &'a AuthenticatedHistories,
    id: &'a str,
    record: &'a Term,
    space: &'a AuthenticDag,
    policy: SpacePolicy<'a>,
}
impl<'a> BootstrapObservation<'a> {
    pub fn observe(
        histories: &'a AuthenticatedHistories,
        space_id: &str,
        bootstrap_id: &str,
    ) -> Result<Self, &'static str> {
        let space = histories.get(space_id).ok_or(PENDING)?.dag();
        let op = space.frame(bootstrap_id).ok_or(PENDING)?;
        let policy = SpacePolicy::analyze(space).map_err(|_| INVALID)?;
        let record = match command(op, "catalog_bootstrap_v1") {
            Some([record]) => record,
            _ => return Err(INVALID),
        };
        let decoded = super::bootstrap::Bootstrap::decode(record).ok_or(INVALID)?;
        if decoded.space != space.replica() {
            return Err(INVALID);
        }
        Ok(Self {
            histories,
            id: op.id(),
            record,
            space,
            policy,
        })
    }
    pub fn id(&self) -> &str {
        self.id
    }
    pub fn record(&self) -> &Term {
        self.record
    }
    /// Current policy is diagnostic evidence, never a reviewed-pin verdict.
    pub fn current_refusal(&self) -> Option<&'static str> {
        self.policy
            .command_reasons()
            .get(self.id)
            .copied()
            .flatten()
    }
    pub fn source(&self) -> &super::frame::AuthenticFrame {
        self.space.frame(self.id).expect("sealed bootstrap source")
    }
}

pub fn observe(
    artifact: &Artifact,
    raw_histories: &[(&str, &[u8])],
) -> Result<EntryObservation, &'static str> {
    let catalog = field(artifact.term(), "catalog").ok_or("malformed_catalog")?;
    envelope::signing_bytes(catalog).map_err(|_| "malformed_catalog")?;
    let histories =
        AuthenticatedHistories::authenticate(raw_histories).map_err(|error| error.reason)?;
    let bootstrap_observation = BootstrapObservation::observe(
        &histories,
        text(field(catalog, "space").ok_or(INVALID)?).ok_or(INVALID)?,
        text(field(catalog, "bootstrap").ok_or(INVALID)?).ok_or(INVALID)?,
    )?;
    if bootstrap_observation.current_refusal().is_some() {
        return Err(INVALID);
    }
    let entries = field(catalog, "entries").ok_or(INVALID)?;
    let facts = bootstrap_observation.entry_facts(artifact)?;
    if facts
        .iter()
        .any(|fact| fact.invalid || !fact.refused.is_empty())
    {
        return Err(INVALID);
    }
    if facts.iter().any(|fact| !fact.pending.is_empty()) {
        return Err(PENDING);
    }
    let bootstrap_id = bootstrap_observation.id();
    let bootstrap = bootstrap_observation.record();
    Ok(EntryObservation {
        entries: entries.clone(),
        bootstrap_id: bootstrap_id.into(),
        bootstrap: bootstrap.clone(),
    })
}

/// Structural, missing and current-policy facts remain separate for frozen
/// diagnostics. No combination of these observations grants retained trust.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct EntryFact {
    invalid: bool,
    pending: Vec<String>,
    refused: Vec<String>,
}
impl EntryFact {
    pub fn invalid(&self) -> bool {
        self.invalid
    }
    pub fn pending(&self) -> &[String] {
        &self.pending
    }
    pub fn refused(&self) -> &[String] {
        &self.refused
    }
}
impl BootstrapObservation<'_> {
    /// All entries are inspected, including available proof after a missing item.
    /// Facts preserve catalog inventory order; each ID set is sorted and unique.
    pub fn entry_facts(&self, artifact: &Artifact) -> Result<Vec<EntryFact>, &'static str> {
        let catalog = field(artifact.term(), "catalog").ok_or("malformed_catalog")?;
        envelope::signing_bytes(catalog).map_err(|_| "malformed_catalog")?;
        if field(catalog, "space").and_then(text) != Some(self.space.replica())
            || field(catalog, "bootstrap").and_then(text) != Some(self.id)
        {
            return Err("wrong_catalog_scope");
        }
        list(field(catalog, "entries").ok_or(INVALID)?)
            .ok_or(INVALID)?
            .iter()
            .map(|entry| self.entry_fact(entry))
            .collect()
    }

    fn entry_fact(&self, entry: &Term) -> Result<EntryFact, &'static str> {
        use std::collections::BTreeSet;
        let mut fact = EntryFact {
            invalid: false,
            pending: Vec::new(),
            refused: Vec::new(),
        };
        let get = |name| field(entry, name).ok_or(INVALID);
        let replica = text(get("replica")?).ok_or(INVALID)?;
        let kind = atom(get("kind")?).ok_or(INVALID)?;
        if !super::delegations::bounded_family(replica)
            || !replica.starts_with(&format!("replica:treehouse:{kind}:"))
            || get("service_id")? != field(self.record, "service_id").ok_or(INVALID)?
            || get("service_key")? != field(self.record, "service_key").ok_or(INVALID)?
        {
            fact.invalid = true;
            return Ok(fact);
        }
        let genesis_id = text(get("genesis")?).ok_or(INVALID)?;
        let creation_id = text(get("creation")?).ok_or(INVALID)?;
        let reference_id = text(get("reference")?).ok_or(INVALID)?;
        let Some(history) = self.histories.get(replica) else {
            fact.pending =
                BTreeSet::from([genesis_id.into(), creation_id.into(), reference_id.into()])
                    .into_iter()
                    .collect();
            return Ok(fact);
        };
        let dag = history.dag();
        let genesis = dag.frame(genesis_id);
        let creation = dag.frame(creation_id);
        let reference = self.space.frame(reference_id);
        let root = key(get("root")?).ok_or(INVALID)?;
        let thread_analysis = if kind == "thread" {
            Some(thread_policy::analyze_with_preflight(dag).map_err(|_| INVALID)?)
        } else {
            None
        };
        let (authority, reasons) = match &thread_analysis {
            Some((preflight, reasons)) => (preflight.authority(), reasons),
            None => (
                self.policy.preflight.authority(),
                self.policy.command_reasons(),
            ),
        };
        fact.invalid = authority.static_delegations.root() != Some(root);
        let mut missing = BTreeSet::new();
        let mut refused = BTreeSet::new();
        for (id, op, target_authority, target_reasons) in [
            (genesis_id, genesis, authority, reasons),
            (creation_id, creation, authority, reasons),
            (
                reference_id,
                reference,
                self.policy.preflight.authority(),
                self.policy.command_reasons(),
            ),
        ] {
            if op.is_none() {
                missing.insert(id.to_owned());
            } else if target_authority.reasons().contains_key(id)
                || target_reasons.get(id).is_some_and(Option::is_some)
            {
                refused.insert(id.to_owned());
            }
        }
        if let Some(genesis) = genesis {
            let delegation = match genesis.body() {
                Term::Tuple(values) if genesis.kind() == "authority" => match values.as_slice() {
                    [tag, delegation, _] if atom(tag) == Some("genesis") => {
                        Delegation::decode(delegation)
                    }
                    _ => None,
                },
                _ => None,
            };
            fact.invalid |= !delegation.is_some_and(|d| {
                genesis.author() == root
                    && d.issuer == root
                    && d.audience == root
                    && d.parent.is_none()
                    && d.replica == replica
                    && d.self_consistent()
            });
        }
        if let Some(creation) = creation {
            fact.invalid |= command(
                creation,
                if kind == "space" {
                    "create_space"
                } else {
                    "create_thread"
                },
            )
            .is_none()
                || (genesis.is_some()
                    && !dag
                        .ancestors(creation_id)
                        .is_some_and(|ids| ids.contains(genesis_id)));
        }
        if kind == "space" {
            fact.invalid |= replica != self.space.replica()
                || Some(replica) != field(self.record, "space").and_then(text)
                || Some(root) != field(self.record, "space_root").and_then(key);
        } else if let Some(reference) = reference {
            fact.invalid |= !matches!(command(reference, "create_thread"), Some([target, _]) if text(target) == Some(replica));
        }
        fact.pending = missing.into_iter().collect();
        fact.refused = refused.into_iter().collect();
        Ok(fact)
    }
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
