//! Private complete-decision fold. Original-only replay precedes every candidate
//! result and sticky fallback. No IPC or installation API is registered here.
use super::*;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use serde_json::json;

fn fail(reason: &'static str) -> ChainError {
    ChainError {
        reason,
        ids: Vec::new(),
    }
}
fn reject(error: ChainError) -> Value {
    let ids: BTreeSet<_> = error.ids.into_iter().collect();
    json!({"kind":"reject","reason":error.reason,"detail":{"ids":ids,"coreReason":null,"pendingProofIds":[]}})
}

pub(super) fn evaluate(snapshot: &[u8], expected: &Value, incoming: &[u8]) -> Value {
    evaluate_original(OriginalEvidence::read(snapshot), expected, || {
        super::page_observation::parse(incoming)
    })
}

// Internal value-plane evaluation, distinct from store/transport byte admission.
// Every value remains untrusted and must replay the same original-only owner.
// No IPC command accepts this interface or a caller-provided validation receipt.
pub(super) fn evaluate_observation(snapshot: Value, expected: &Value, incoming: Value) -> Value {
    evaluate_original(OriginalEvidence::observe(snapshot), expected, || {
        super::page_observation::observe(incoming)
    })
}

fn evaluate_original(
    original: Result<OriginalEvidence, ChainError>,
    expected: &Value,
    page: impl FnOnce() -> Result<Value, &'static str>,
) -> Value {
    let original = match original.and_then(OriginalEvidence::validate) {
        Ok(original) => original,
        Err(error) => return reject(error),
    };
    match evaluate_validated(original, expected, page) {
        Ok(decision) => decision,
        Err(error) => reject(error),
    }
}

fn evaluate_validated(
    owner: ValidatedOriginal,
    expected: &Value,
    read_page: impl FnOnce() -> Result<Value, &'static str>,
) -> Result<Value, ChainError> {
    if !closed_json(expected, &["trustRevision", "historyGeneration"])
        || ["trustRevision", "historyGeneration"]
            .iter()
            .any(|name| counter(&expected[*name]).is_none_or(|n| n >= HORIZON))
    {
        return Err(fail("malformed_catalog"));
    }
    let page = read_page().map_err(fail)?;
    let original = owner.evidence.snapshot.raw();
    let histories = super::super::histories::AuthenticatedHistories::authenticate_union(
        &original["histories"],
        &page["histories"],
    )
    .map_err(|error| ChainError {
        reason: error.reason,
        ids: error.ids,
    })?;
    let bootstrap = reviewed_bootstrap(&histories, &original["review"])?;
    let record =
        super::super::bootstrap::Bootstrap::decode(bootstrap.record()).ok_or_else(recovery)?;
    let replacement = bootstrap
        .policy()
        .preflight
        .authority()
        .binding_current()
        .is_some_and(|(root, genesis, id, _)| {
            root == record.root && genesis == record.profile_genesis && id == record.profile_id
        });
    let bootstrap_ids = honored_bootstraps(&bootstrap);
    let refused = accepted_refusals(&bootstrap, original)?;
    let security = security_block(original, &refused, &bootstrap_ids, &histories);
    // Capture fallback eligibility only after candidate history authentication
    // and actual current accepted-target policy have completed successfully.
    let context = IncomingContext {
        original,
        expected,
        page: &page,
        histories: &histories,
        bootstrap: &bootstrap,
        replacement,
        bootstrap_ids: &bootstrap_ids,
    };
    match context.candidate() {
        Ok(decision) => Ok(decision),
        Err(error) => {
            if !security.is_null() {
                // The immutable authenticated context supplies the same fallback
                // only when needed; successful candidates retain no spare copy.
                let frozen = context.checkpoint(
                    original["catalogs"].clone(),
                    original["rotations"].clone(),
                    original["cutoffProofs"].clone(),
                    security,
                );
                let heads = frozen["blocked"]["bindings"].clone();
                let reason = frozen["blocked"]["reason"].clone();
                context.issue(
                    "retain_blocked",
                    frozen,
                    reason,
                    heads,
                    json!([]),
                    json!([]),
                )
            } else {
                Err(error)
            }
        }
    }
}

struct Inventory {
    artifacts: Vec<Artifact>,
    rows: Vec<Value>,
}
fn inventory(
    original: &Value,
    page: &Value,
    name: &str,
    bootstrap: &BootstrapObservation<'_>,
) -> Result<Inventory, ChainError> {
    let mut records: BTreeMap<String, (Artifact, String, Option<Vec<u8>>)> = BTreeMap::new();
    let sources = original[name]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["json"].as_str().unwrap())
        .chain(
            page[name]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap()),
        );
    for raw in sources {
        let artifact = super::super::artifact::parse(raw.as_bytes()).map_err(fail)?;
        let (id, signature) = if name == "catalogs" {
            let fields =
                super::super::evidence_terms::closed(artifact.term(), &["catalog", "signature"])
                    .ok_or_else(|| fail("malformed_catalog"))?;
            super::super::envelope::signing_bytes(fields["catalog"])
                .map_err(|_| fail("malformed_catalog"))?;
            let signature = binary(fields["signature"])
                .filter(|bytes| bytes.len() == 64)
                .ok_or_else(|| fail("malformed_catalog"))?;
            let id = digest("lattice-treehouse-transport-catalog-v1", fields["catalog"])
                .ok_or_else(|| fail("malformed_catalog"))?;
            chains::check_scope(bootstrap.record(), bootstrap.id(), fields["catalog"], &id)?;
            (id, Some(signature.to_vec()))
        } else {
            let envelope = rotation::Envelope::decode(artifact.term())
                .ok_or_else(|| fail("malformed_catalog"))?;
            let id = envelope.id().ok_or_else(|| fail("malformed_catalog"))?;
            chains::check_scope(
                bootstrap.record(),
                bootstrap.id(),
                envelope.rotation.term(),
                &id,
            )?;
            (id, None)
        };
        if let Some((_, _, prior_signature)) = records.get(&id) {
            if signature != *prior_signature {
                return Err(ChainError {
                    reason: "invalid_catalog_signature",
                    ids: vec![id],
                });
            }
        } else {
            records.insert(id, (artifact, raw.into(), signature));
        }
    }
    let mut artifacts = Vec::with_capacity(records.len());
    let mut rows = Vec::with_capacity(records.len());
    for (id, (artifact, raw, _)) in records {
        artifacts.push(artifact);
        rows.push(json!({"id":id,"json":raw}));
    }
    Ok(Inventory { artifacts, rows })
}

struct IncomingContext<'a, 'dag> {
    original: &'a Value,
    expected: &'a Value,
    page: &'a Value,
    histories: &'dag super::super::histories::AuthenticatedHistories,
    bootstrap: &'a BootstrapObservation<'dag>,
    replacement: bool,
    bootstrap_ids: &'a [String],
}
impl IncomingContext<'_, '_> {
    // Copy each output field once. Never clone a saved history or inventory just
    // to overwrite it with the authenticated union or newly validated rows.
    fn checkpoint(
        &self,
        catalogs: Value,
        rotations: Value,
        cutoff_proofs: Value,
        blocked: Value,
    ) -> Value {
        let original = self.original;
        let mut next = json!({"version":original["version"],"review":original["review"],"accepted":original["accepted"]});
        let fields = next.as_object_mut().unwrap();
        fields.insert(
            "histories".into(),
            Value::Array(
                self.histories
                    .iter()
                    .map(|(_, history)| history.raw().clone())
                    .collect(),
            ),
        );
        fields.insert("catalogs".into(), catalogs);
        fields.insert("rotations".into(), rotations);
        fields.insert("cutoffProofs".into(), cutoff_proofs);
        fields.insert("blocked".into(), blocked);
        next
    }

    fn candidate(&self) -> Result<Value, ChainError> {
        let original = self.original;
        let page = self.page;
        let histories = self.histories;
        let bootstrap = self.bootstrap;
        let bootstrap_ids = self.bootstrap_ids;
        let catalogs = inventory(original, page, "catalogs", bootstrap)?;
        let rotations = inventory(original, page, "rotations", bootstrap)?;
        let mut graph = Graph::observe(
            bootstrap,
            &catalogs.artifacts,
            &rotations.artifacts,
            original,
        )?;
        let proofs = Proofs::observe(
            original["cutoffProofs"].as_array().unwrap(),
            page["cutoffProofs"].as_array().unwrap(),
            histories,
        )?;
        graph.complete_cutoffs(&proofs);
        let mut next = self.checkpoint(
            Value::Array(catalogs.rows),
            Value::Array(rotations.rows),
            Value::Array(proofs.rows),
            derived_block(original, &graph, bootstrap_ids, histories),
        );
        validate_routes(&catalogs.artifacts, &graph)?;
        validate_watermark(original, &graph)?;
        let heads = json!(graph.links.binding_heads);
        let catalog_heads = json!(graph
            .links
            .catalog_heads
            .iter()
            .map(|(binding, ids)| json!({"binding":binding,"catalogs":ids}))
            .collect::<Vec<_>>());
        let mut additions = BTreeMap::new();
        let mut retained_count = 0usize;
        let mut retained_bytes = 0usize;
        for (name, kind) in [("catalogs", "catalog"), ("rotations", "rotation")] {
            let saved = original[name].as_array().unwrap();
            retained_count += saved.len();
            retained_bytes += saved
                .iter()
                .map(|row| row["json"].as_str().unwrap().len())
                .sum::<usize>();
            let have: BTreeSet<_> = saved
                .iter()
                .map(|row| row["id"].as_str().unwrap())
                .collect();
            for row in next[name].as_array().unwrap() {
                let id = row["id"].as_str().unwrap();
                if have.contains(id) {
                    continue;
                }
                let raw = row["json"].as_str().unwrap();
                additions.insert(format!("{kind}:{id}"),json!({"kind":kind,"id":id,"digest":URL_SAFE_NO_PAD.encode(Sha256::digest(raw.as_bytes())),"bytes":raw.len()}));
            }
        }
        let prior_triggers = original["blocked"]["triggers"]
            .as_array()
            .filter(|v| !v.is_empty());
        let overflow = retained_count + additions.len() > 1024
            || retained_bytes
                + additions
                    .values()
                    .map(|v| counter(&v["bytes"]).unwrap() as usize)
                    .sum::<usize>()
                > 16 * 1024 * 1024;
        if prior_triggers.is_some() || overflow {
            for name in ["catalogs", "rotations", "cutoffProofs"] {
                next[name] = original[name].clone();
            }
            let triggers = prior_triggers
                .map(|v| json!(v))
                .unwrap_or_else(|| json!(additions.into_values().collect::<Vec<_>>()));
            if next["blocked"]["reason"] != "authority_changed" {
                next["blocked"] = block(
                    "control_history_limit",
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                );
            }
            next["blocked"]["triggers"] = triggers;
            let reason = next["blocked"]["reason"].clone();
            return self.issue(
                "retain_blocked",
                next,
                reason,
                json!([]),
                json!([]),
                json!([]),
            );
        }
        if !next["blocked"].is_null() {
            let reason = next["blocked"]["reason"].clone();
            return self.issue(
                "retain_blocked",
                next,
                reason,
                heads,
                catalog_heads,
                json!([]),
            );
        }
        let head = graph
            .links
            .binding_heads
            .first()
            .ok_or_else(|| fail("invalid_catalog_transition"))?;
        let binding = &graph.links.bindings[head];
        let latest = graph
            .links
            .catalog_heads
            .get(head)
            .and_then(|ids| ids.first());
        let reason = if !graph.binding_pending[head].is_empty() {
            json!("recovery_incomplete")
        } else if latest.is_none_or(|id| !graph.catalog_pending[id].is_empty()) {
            json!("trust_pending")
        } else {
            let id = latest.unwrap();
            next["accepted"] = json!({"binding":head,"generation":binding.generation,"catalog":id,"revision":graph.links.catalogs[id].revision});
            Value::Null
        };
        let routes = route_candidates(&next["accepted"], &catalogs.artifacts, &graph, bootstrap)?;
        let kind = if super::super::raw_numbers::values_equal(&next, original) {
            "unchanged"
        } else {
            "propose"
        };
        self.issue(kind, next, reason, heads, catalog_heads, routes)
    }
}

fn route_candidates(
    accepted: &Value,
    catalogs: &[Artifact],
    graph: &Graph,
    bootstrap: &BootstrapObservation<'_>,
) -> Result<Value, ChainError> {
    let Some(id) = accepted["catalog"].as_str() else {
        return Ok(json!([]));
    };
    let catalog = catalogs
        .iter()
        .find_map(|a| {
            let c = field(a.term(), "catalog")?;
            (digest("lattice-treehouse-transport-catalog-v1", c).as_deref() == Some(id))
                .then_some(c)
        })
        .ok_or_else(recovery)?;
    let binding = accepted["binding"].as_str().ok_or_else(recovery)?;
    if !graph.links.bindings.contains_key(binding) {
        return Err(recovery());
    }
    let origin = field(bootstrap.record(), "origin")
        .and_then(text)
        .ok_or_else(recovery)?;
    let mut routes = Vec::new();
    for entry in list(field(catalog, "entries").ok_or_else(recovery)?).ok_or_else(recovery)? {
        let t = |name| field(entry, name).and_then(text).ok_or_else(recovery);
        let a = |name| field(entry, name).and_then(atom).ok_or_else(recovery);
        let path = t("route")?;
        let service = t("service_id")?;
        routes.push(json!({"replica":t("replica")?,"kind":a("kind")?,"schema":a("schema")?,"root":STANDARD.encode(field(entry,"root").and_then(binary).ok_or_else(recovery)?),
            "genesis":t("genesis")?,"creation":t("creation")?,"reference":t("reference")?,"binding":binding,"catalog":id,"revision":graph.links.catalogs[id].revision,
            "origin":origin,"path":path,"url":format!("{origin}{path}"),"serviceId":service,"serviceKey":STANDARD.encode(field(entry,"service_key").and_then(binary).ok_or_else(recovery)?),"realm":format!("treehouse-service:{service}")}));
    }
    Ok(json!(routes))
}

impl IncomingContext<'_, '_> {
    fn issue(
        &self,
        kind: &str,
        next: Value,
        reason: Value,
        heads: Value,
        catalog_heads: Value,
        routes: Value,
    ) -> Result<Value, ChainError> {
        let expected = self.expected;
        let replacement = self.replacement;
        let bootstrap_ids = self.bootstrap_ids;
        if !super::super::json::within_observation(&next, 205) {
            return Err(fail("invalid_verified_history"));
        }
        let ids = next["blocked"]["opIds"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let pending = next["blocked"]["pendingProofIds"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut decision = json!({"kind":kind,"expected":expected,"reason":reason,"replacementConfigured":replacement,
        "observed":{"bootstrapIds":bootstrap_ids,"bindingHeads":heads,"catalogHeads":catalog_heads},"detail":{"ids":ids,"coreReason":null,"pendingProofIds":pending},"routes":routes});
        decision["next"] = next;
        Ok(decision)
    }
}
