//! Catalog and rotation links under an authenticated, observed bootstrap.
//! This does not select a trusted pin or judge entry authority, cutoff proofs,
//! historical views, forks, retained state, freshness or routes. The incoming
//! owner must bound the aggregate candidate set before calling this component.
use super::{
    artifact::Artifact, canonical::Term, entries::EntryObservation, envelope, evidence_terms::*,
    frame, rotation,
};
use std::collections::{BTreeMap, BTreeSet};

const MALFORMED: &str = "malformed_catalog";
const TRANSITION: &str = "invalid_catalog_transition";
#[derive(Debug, PartialEq, Eq)]
pub struct ChainError {
    pub reason: &'static str,
    pub ids: Vec<String>,
}
fn failure(reason: &'static str, id: &str) -> ChainError {
    ChainError {
        reason,
        ids: if id.is_empty() {
            Vec::new()
        } else {
            vec![id.into()]
        },
    }
}
#[derive(Debug, serde::Serialize)]
pub struct BindingObservation {
    pub(super) generation: u64,
    pub(super) key: Vec<u8>,
    pub(super) parent: Option<String>,
    pub(super) prior: Option<String>,
    pub(super) inventory: Option<String>,
}
#[derive(Debug, serde::Serialize)]
pub struct CatalogObservation {
    pub(super) binding: String,
    pub(super) revision: u64,
    pub(super) previous: Option<String>,
}
#[derive(Debug, serde::Serialize)]
pub struct ChainObservation {
    pub(super) bindings: BTreeMap<String, BindingObservation>,
    pub(super) catalogs: BTreeMap<String, CatalogObservation>,
    pub(super) binding_heads: Vec<String>,
    pub(super) catalog_heads: BTreeMap<String, Vec<String>>,
}
struct Catalog<'a> {
    term: &'a Term,
    signature: &'a [u8],
    binding: &'a str,
    previous: Option<&'a str>,
    revision: u64,
}
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Node {
    Catalog(String),
    Binding(String),
}
enum Work {
    Catalog(String),
    CatalogSigned(String),
    CatalogFinish(String),
    Binding(String),
    RotationSigned(String),
    RotationFinish(String),
}
struct Context<'a> {
    bootstrap_id: &'a str,
    bootstrap: &'a Term,
    catalogs: BTreeMap<String, Catalog<'a>>,
    rotations: BTreeMap<String, rotation::Envelope<'a>>,
    bindings: BTreeMap<String, BindingObservation>,
    ready: BTreeSet<String>,
    visiting: BTreeSet<Node>,
}

pub fn observe(
    bootstrap: &EntryObservation,
    catalogs: &[Artifact],
    rotations: &[Artifact],
) -> Result<ChainObservation, ChainError> {
    observe_record(
        bootstrap.bootstrap_id(),
        bootstrap.bootstrap(),
        catalogs,
        rotations,
        |_, _| Ok(()),
    )
}

/// Structural graph observation before catalog entries are complete. The sealed
/// bootstrap is authenticated; current refusal stays diagnostic. This establishes no
/// reviewed pin, entry eligibility, retained trust, freshness or usable route.
pub fn observe_bootstrap(
    bootstrap: &super::entries::BootstrapObservation<'_>,
    catalogs: &[Artifact],
    rotations: &[Artifact],
) -> Result<ChainObservation, ChainError> {
    observe_record(
        bootstrap.id(),
        bootstrap.record(),
        catalogs,
        rotations,
        |_, _| Ok(()),
    )
}

/// Join entry proof at the same graph stage as the source owner. This internal
/// hook is constructed by the retained fold; it is not a caller trust flag.
pub(super) fn observe_with_entries(
    bootstrap: &super::entries::BootstrapObservation<'_>,
    catalogs: &[Artifact],
    rotations: &[Artifact],
    check_entries: impl FnMut(&str, &Term) -> Result<(), ChainError>,
) -> Result<ChainObservation, ChainError> {
    observe_record(
        bootstrap.id(),
        bootstrap.record(),
        catalogs,
        rotations,
        check_entries,
    )
}

fn observe_record(
    bootstrap_id: &str,
    record: &Term,
    catalogs: &[Artifact],
    rotations: &[Artifact],
    mut check_entries: impl FnMut(&str, &Term) -> Result<(), ChainError>,
) -> Result<ChainObservation, ChainError> {
    let key = field(record, "catalog_key")
        .and_then(key)
        .ok_or_else(|| failure(MALFORMED, ""))?;
    let mut context = Context {
        bootstrap_id,
        bootstrap: record,
        catalogs: BTreeMap::new(),
        rotations: BTreeMap::new(),
        ready: BTreeSet::new(),
        visiting: BTreeSet::new(),
        bindings: BTreeMap::from([(
            bootstrap_id.into(),
            BindingObservation {
                generation: 0,
                key: key.into(),
                parent: None,
                prior: None,
                inventory: None,
            },
        )]),
    };
    let mut parsed_catalogs = Vec::with_capacity(catalogs.len());
    for artifact in catalogs {
        let fields = closed(artifact.term(), &["catalog", "signature"])
            .ok_or_else(|| failure(MALFORMED, ""))?;
        let term = fields["catalog"];
        envelope::signing_bytes(term).map_err(|_| failure(MALFORMED, ""))?;
        let signature = binary(fields["signature"])
            .filter(|v| v.len() == 64)
            .ok_or_else(|| failure(MALFORMED, ""))?;
        let id = digest("lattice-treehouse-transport-catalog-v1", term)
            .ok_or_else(|| failure(MALFORMED, ""))?;
        context.scope(term, &id)?;
        let previous = match field(term, "previous") {
            Some(Term::Nil) => None,
            Some(term) => text(term),
            None => None,
        };
        let node = Catalog {
            term,
            signature,
            binding: text(field(term, "binding").unwrap()).unwrap(),
            previous,
            revision: integer(field(term, "revision").unwrap()).unwrap(),
        };
        parsed_catalogs.push((id, node));
    }
    // Source admission parses/scopes every catalog before duplicate-signature
    // checks, preserving its error precedence on pages with multiple faults.
    for (id, node) in parsed_catalogs {
        if let Some(old) = context.catalogs.get(&id) {
            if old.signature != node.signature {
                return Err(failure("invalid_catalog_signature", &id));
            }
        } else {
            context.catalogs.insert(id, node);
        }
    }
    for artifact in rotations {
        let node =
            rotation::Envelope::decode(artifact.term()).ok_or_else(|| failure(MALFORMED, ""))?;
        let id = node.id().ok_or_else(|| failure(MALFORMED, ""))?;
        context.scope(node.rotation.term(), &id)?;
        context.rotations.entry(id).or_insert(node);
    }
    for id in context.catalogs.keys().cloned().collect::<Vec<_>>() {
        context.resolve(Work::Catalog(id), &mut check_entries)?;
    }
    for id in context.rotations.keys().cloned().collect::<Vec<_>>() {
        context.resolve(Work::Binding(id), &mut check_entries)?;
    }
    let parents: BTreeSet<_> = context
        .bindings
        .values()
        .filter_map(|b| b.parent.as_ref())
        .collect();
    let binding_heads = context
        .bindings
        .keys()
        .filter(|id| !parents.contains(id))
        .cloned()
        .collect();
    let mut catalog_heads: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let previous: BTreeSet<_> = context
        .catalogs
        .values()
        .filter_map(|c| c.previous)
        .collect();
    let mut observed = BTreeMap::new();
    for (id, catalog) in context.catalogs {
        if !previous.contains(id.as_str()) {
            catalog_heads
                .entry(catalog.binding.into())
                .or_default()
                .push(id.clone());
        }
        // Include empty groups as in the complete per-binding catalog index.
        catalog_heads.entry(catalog.binding.into()).or_default();
        observed.insert(
            id,
            CatalogObservation {
                binding: catalog.binding.into(),
                revision: catalog.revision,
                previous: catalog.previous.map(str::to_owned),
            },
        );
    }
    Ok(ChainObservation {
        bindings: context.bindings,
        catalogs: observed,
        binding_heads,
        catalog_heads,
    })
}
pub(super) fn check_scope(
    bootstrap: &Term,
    bootstrap_id: &str,
    record: &Term,
    id: &str,
) -> Result<(), ChainError> {
    if field(record, "space") != field(bootstrap, "space")
        || field(record, "bootstrap").and_then(text) != Some(bootstrap_id)
    {
        return Err(failure("wrong_catalog_scope", id));
    }
    Ok(())
}

impl Context<'_> {
    fn scope(&self, record: &Term, id: &str) -> Result<(), ChainError> {
        check_scope(self.bootstrap, self.bootstrap_id, record, id)
    }
    fn resolve(
        &mut self,
        first: Work,
        check_entries: &mut impl FnMut(&str, &Term) -> Result<(), ChainError>,
    ) -> Result<(), ChainError> {
        let mut work = vec![first];
        while let Some(task) = work.pop() {
            match task {
                Work::Catalog(id) => {
                    if self.ready.contains(&id) {
                        continue;
                    }
                    let catalog = self
                        .catalogs
                        .get(&id)
                        .ok_or_else(|| failure("trust_pending", &id))?;
                    if !self.visiting.insert(Node::Catalog(id.clone())) {
                        return Err(failure(TRANSITION, &id));
                    }
                    work.push(Work::CatalogSigned(id));
                    work.push(Work::Binding(catalog.binding.into()));
                }
                Work::CatalogSigned(id) => {
                    let catalog = &self.catalogs[&id];
                    let binding = &self.bindings[catalog.binding];
                    let bytes = envelope::signing_bytes(catalog.term)
                        .map_err(|_| failure(MALFORMED, &id))?;
                    frame::verify_signature(&binding.key, &bytes, catalog.signature)
                        .map_err(|_| failure("invalid_catalog_signature", &id))?;
                    for entry in list(field(catalog.term, "entries").unwrap()).unwrap() {
                        if field(entry, "service_id") != field(self.bootstrap, "service_id")
                            || field(entry, "service_key") != field(self.bootstrap, "service_key")
                        {
                            return Err(failure("wrong_catalog_scope", &id));
                        }
                    }
                    if let Some(previous) = catalog.previous {
                        work.push(Work::CatalogFinish(id));
                        work.push(Work::Catalog(previous.into()));
                    } else {
                        if binding.inventory.as_deref().is_some_and(|expected| {
                            inventory(catalog.term).as_deref() != Some(expected)
                        }) {
                            return Err(failure(TRANSITION, &id));
                        }
                        check_entries(&id, catalog.term)?;
                        self.ready.insert(id.clone());
                        self.visiting.remove(&Node::Catalog(id));
                    }
                }
                Work::CatalogFinish(id) => {
                    let catalog = &self.catalogs[&id];
                    let previous = &self.catalogs[catalog.previous.unwrap()];
                    if previous.binding != catalog.binding
                        || previous.revision.checked_add(1) != Some(catalog.revision)
                        || catalog.revision > HORIZON
                        || !extends(previous.term, catalog.term)
                    {
                        return Err(failure(TRANSITION, &id));
                    }
                    check_entries(&id, catalog.term)?;
                    self.ready.insert(id.clone());
                    self.visiting.remove(&Node::Catalog(id));
                }
                Work::Binding(id) => {
                    if self.bindings.contains_key(&id) {
                        continue;
                    }
                    let rotation = self
                        .rotations
                        .get(&id)
                        .ok_or_else(|| failure("trust_pending", &id))?;
                    if !self.visiting.insert(Node::Binding(id.clone())) {
                        return Err(failure(TRANSITION, &id));
                    }
                    work.push(Work::RotationSigned(id));
                    work.push(Work::Binding(rotation.rotation.parent.into()));
                }
                Work::RotationSigned(id) => {
                    let envelope = &self.rotations[&id];
                    let rotation = &envelope.rotation;
                    let parent = &self.bindings[rotation.parent];
                    if parent.generation.checked_add(1) != Some(rotation.generation)
                        || rotation.generation > HORIZON
                        || parent.key == rotation.new_catalog_key
                        || Some(rotation.new_catalog_key)
                            == field(self.bootstrap, "service_key").and_then(key)
                    {
                        return Err(failure(TRANSITION, &id));
                    }
                    frame::verify_signature(
                        &parent.key,
                        &rotation.signing_bytes().unwrap(),
                        envelope.old_signature,
                    )
                    .map_err(|_| failure("invalid_catalog_signature", &id))?;
                    frame::verify_signature(
                        rotation.new_catalog_key,
                        &rotation.possession_bytes().unwrap(),
                        envelope.new_signature,
                    )
                    .map_err(|_| failure("invalid_possession", &id))?;
                    work.push(Work::RotationFinish(id));
                    work.push(Work::Catalog(rotation.prior_catalog.into()));
                }
                Work::RotationFinish(id) => {
                    let rotation = &self.rotations[&id].rotation;
                    let prior = &self.catalogs[rotation.prior_catalog];
                    let replicas = list(field(prior.term, "entries").unwrap())
                        .unwrap()
                        .iter()
                        .map(|entry| field(entry, "replica").and_then(text).unwrap())
                        .collect::<Vec<_>>();
                    if prior.binding != rotation.parent
                        || inventory(prior.term).as_deref() != Some(rotation.inventory_digest)
                        || replicas
                            != rotation
                                .cutoffs
                                .iter()
                                .map(|c| c.replica)
                                .collect::<Vec<_>>()
                    {
                        return Err(failure(TRANSITION, &id));
                    }
                    self.bindings.insert(
                        id.clone(),
                        BindingObservation {
                            generation: rotation.generation,
                            key: rotation.new_catalog_key.into(),
                            parent: Some(rotation.parent.into()),
                            prior: Some(rotation.prior_catalog.into()),
                            inventory: Some(rotation.inventory_digest.into()),
                        },
                    );
                    self.visiting.remove(&Node::Binding(id));
                }
            }
        }
        Ok(())
    }
}
fn inventory(catalog: &Term) -> Option<String> {
    digest(
        "lattice-treehouse-route-inventory-v1",
        field(catalog, "entries")?,
    )
}
fn extends(previous: &Term, next: &Term) -> bool {
    let next = list(field(next, "entries").unwrap()).unwrap();
    list(field(previous, "entries").unwrap())
        .unwrap()
        .iter()
        .all(|old| {
            next.iter()
                .find(|entry| field(entry, "replica") == field(old, "replica"))
                .is_some_and(|entry| {
                    ["root", "genesis", "creation", "reference", "kind", "schema"]
                        .iter()
                        .all(|name| field(old, name) == field(entry, name))
                })
        })
}
