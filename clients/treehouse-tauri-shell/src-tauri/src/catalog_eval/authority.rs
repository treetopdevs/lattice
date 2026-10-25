//! Bounded Treehouse authority evidence, independently folded from an authentic
//! DAG. Command policy, semantic normalization and catalog trust remain separate;
//! this result cannot install a route or stand in for a final catalog decision.
use super::{
    canonical::Term,
    delegations::{Delegation, StaticDelegations, Validation},
    evidence_terms::*,
    frame::AuthenticFrame,
    history::AuthenticDag,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Acquire {
    op_id: String,
    holder: Vec<u8>,
    pub(super) delegation_id: String,
    at_tick: u64,
}
impl Acquire {
    pub fn op_id(&self) -> &str {
        &self.op_id
    }
    pub fn holder(&self) -> &[u8] {
        &self.holder
    }
    pub fn at_tick(&self) -> u64 {
        self.at_tick
    }
}
#[derive(Debug, Default)]
pub struct Timeline {
    acquires: Vec<Acquire>,
    heartbeats: Vec<(String, u64)>,
}
impl Timeline {
    pub fn acquires(&self) -> &[Acquire] {
        &self.acquires
    }
}
#[derive(Debug)]
pub struct AuthorityEvidence<'a> {
    pub(super) static_delegations: StaticDelegations<'a>,
    beacons: Vec<(String, u64)>,
    timelines: BTreeMap<String, Timeline>,
    reasons: BTreeMap<String, &'static str>,
}
#[derive(Clone)]
struct Policy {
    witnesses: Vec<Vec<u8>>,
    threshold: u64,
    step: u64,
}
#[derive(Clone)]
struct Profile {
    term: Term,
    kind: String,
    role: String,
    nominee: Vec<u8>,
    witnesses: Vec<Vec<u8>>,
    threshold: u64,
    width: u64,
}
struct Pin {
    op_id: String,
    profile: Profile,
}
impl<'a> AuthorityEvidence<'a> {
    pub fn analyze(dag: &'a AuthenticDag) -> Result<Self, &'static str> {
        let static_delegations = StaticDelegations::analyze(dag)?;
        let kind = if dag.replica().starts_with("replica:treehouse:space:") {
            "space"
        } else {
            "thread"
        };
        let roles = if kind == "space" {
            vec!["admin", "moderator"]
        } else {
            vec!["moderator"]
        };
        let mut result = Self {
            reasons: static_delegations.reasons().clone(),
            static_delegations,
            beacons: Vec::new(),
            timelines: roles
                .iter()
                .map(|r| (r.to_string(), Timeline::default()))
                .collect(),
        };
        let mut policies = Vec::new();
        let mut pins = Vec::new();
        for id in dag.order() {
            let op = dag.frame(id).unwrap();
            let Some(body) = authority_body(op) else {
                continue;
            };
            let [Term::Atom(name), term, settings] = body else {
                continue;
            };
            if name != "genesis" {
                continue;
            }
            let Some(d) = Delegation::decode(term) else {
                continue;
            };
            if !result.valid_intro(op, &d)
                || result.static_delegations.records()[&d.id].validation != Validation::Valid
                || d.parent.is_some()
                || op.author() != d.audience
                || Some(op.author()) != result.static_delegations.root()
            {
                continue;
            }
            if let Some(p) = field(settings, "__beacon__").and_then(beacon_policy) {
                policies.push((id.clone(), p));
            }
            if d.issuer == d.audience
                && d.expires.is_none()
                && !d.live
                && d.roles.is_empty()
                && d.ops.is_empty()
            {
                if let Some(profile) = field(settings, "__continuation__").and_then(profile) {
                    if profile.kind == kind {
                        pins.push(Pin {
                            op_id: id.clone(),
                            profile,
                        });
                    }
                }
            }
        }
        result.collect_beacons(&policies);
        for role in roles {
            let mut timeline = Timeline::default();
            for id in dag.order() {
                let op = dag.frame(id).unwrap();
                let Some(body) = authority_body(op) else {
                    continue;
                };
                match body {
                    [Term::Atom(name), term, _] if name == "genesis" => {
                        let Some(d) = Delegation::decode(term) else {
                            continue;
                        };
                        if !result.valid_intro(op, &d)
                            || !d.roles.contains(role)
                            || result.static_delegations.records()[&d.id].validation
                                != Validation::Valid
                        {
                            continue;
                        }
                        if d.parent.is_some() {
                            result.reasons.insert(id.clone(), "invalid_genesis");
                        } else if op.author() != d.audience {
                            result.reasons.insert(id.clone(), "unauthorized_genesis");
                        } else {
                            acquire(&mut timeline, op, &d, 0);
                        }
                    }
                    [Term::Atom(name), Term::Atom(r), term, tick]
                        if name == "transfer" && r == role =>
                    {
                        let Some(d) = Delegation::decode(term) else {
                            continue;
                        };
                        let Some(tick) = integer(tick) else {
                            result.reasons.insert(id.clone(), "malformed_term");
                            continue;
                        };
                        if !result.valid_intro(op, &d) {
                            continue;
                        }
                        let visible = dag.ancestors(id).unwrap();
                        let valid = match &result.static_delegations.records()[&d.id].validation {
                            Validation::Valid => true,
                            Validation::SuccessionCandidate(root) => {
                                timeline.acquires.iter().any(|a| {
                                    a.delegation_id == *root && visible.contains(a.op_id.as_str())
                                })
                            }
                            _ => false,
                        };
                        let predecessor = timeline
                            .acquires
                            .iter()
                            .rev()
                            .find(|a| visible.contains(a.op_id.as_str()));
                        let reason = if !valid || op.author() != d.issuer || !d.roles.contains(role)
                        {
                            Some("invalid_transfer")
                        } else if result.static_delegations.revoked_as_of(id, &d.id) == Some(true) {
                            Some("revoked_capability")
                        } else if predecessor.map(|p| p.holder.as_slice()) != Some(op.author()) {
                            Some("transfer_not_holder")
                        } else if timeline.acquires.last().map(|p| p.holder.as_slice())
                            != Some(op.author())
                            || predecessor != timeline.acquires.last()
                        {
                            Some("double_transfer")
                        } else {
                            None
                        };
                        if let Some(reason) = reason {
                            result.reasons.insert(id.clone(), reason);
                        } else {
                            acquire(&mut timeline, op, &d, tick);
                        }
                    }
                    [Term::Atom(name), Term::Atom(r), term, proof]
                        if name == "succeed" && r == role =>
                    {
                        let Some(d) = Delegation::decode(term) else {
                            continue;
                        };
                        if !proof_head(proof) && !result.valid_intro(op, &d) {
                            continue;
                        }
                        match result.continue_role(op, role, &d, proof, &timeline, &pins) {
                            Ok(epoch) => acquire(&mut timeline, op, &d, epoch),
                            Err(reason) => {
                                result.reasons.insert(id.clone(), reason);
                            }
                        }
                    }
                    [Term::Atom(name), Term::Atom(r), tick] if name == "heartbeat" && r == role => {
                        let Some(tick) = integer(tick) else {
                            result.reasons.insert(id.clone(), "malformed_term");
                            continue;
                        };
                        let visible = dag.ancestors(id).unwrap();
                        if timeline
                            .acquires
                            .iter()
                            .rev()
                            .find(|a| visible.contains(a.op_id.as_str()))
                            .is_some_and(|p| p.holder == op.author())
                        {
                            timeline.heartbeats.push((id.clone(), tick));
                        }
                    }
                    _ => {}
                }
            }
            result.timelines.insert(role.to_string(), timeline);
        }
        // Continuation-shaped evidence outside a declared role is still judged;
        // malformed ticks are structural even when the role is undeclared.
        for id in dag.order() {
            let op = dag.frame(id).unwrap();
            let Some(body) = authority_body(op) else {
                continue;
            };
            if let [Term::Atom(name), role, term, proof] = body {
                if name == "succeed" && atom(role).is_none_or(|r| !result.timelines.contains_key(r))
                {
                    if let Some(d) = Delegation::decode(term) {
                        let role = atom(role).unwrap_or("");
                        let reason = result
                            .continue_role(op, role, &d, proof, &Timeline::default(), &pins)
                            .unwrap_err();
                        result.reasons.insert(id.clone(), reason);
                    } else if proof_head(proof) {
                        result.reasons.insert(id.clone(), "malformed_term");
                    }
                }
                if name == "transfer"
                    && Delegation::decode(term).is_some()
                    && integer(proof).is_none()
                {
                    result.reasons.insert(id.clone(), "malformed_term");
                }
            }
            if body.len() >= 4
                && atom(&body[0]) == Some("succeed")
                && proof_head(&body[3])
                && (body.len() != 4
                    || atom(&body[1]).is_none()
                    || Delegation::decode(&body[2]).is_none())
            {
                result.reasons.insert(id.clone(), "malformed_term");
            }
            if let [Term::Atom(name), _, tick] = body {
                if name == "heartbeat" && integer(tick).is_none() {
                    result.reasons.insert(id.clone(), "malformed_term");
                }
            }
        }
        Ok(result)
    }
    fn valid_intro(&self, op: &AuthenticFrame, d: &Delegation) -> bool {
        self.static_delegations
            .records()
            .get(&d.id)
            .is_some_and(|r| r.introductions.iter().any(|id| id == op.id()))
    }
    fn collect_beacons(&mut self, policies: &[(String, Policy)]) {
        let dag = self.static_delegations.dag;
        for id in dag.order() {
            let op = dag.frame(id).unwrap();
            let Some(body) = authority_body(op) else {
                continue;
            };
            if !(matches!(body.len(), 2 | 3) && atom(&body[0]) == Some("beacon")) {
                continue;
            }
            let visible = dag.ancestors(id).unwrap();
            let prior = self
                .beacons
                .iter()
                .filter(|(id, _)| visible.contains(id.as_str()))
                .map(|(_, e)| *e)
                .max();
            let epoch = integer(&body[1]);
            let root = self.static_delegations.root();
            let reason = if body.len() == 2 {
                if Some(op.author()) != root {
                    Some("unauthorized_beacon")
                } else if epoch.is_none() || prior.is_some_and(|p| epoch.unwrap() <= p) {
                    Some("stale_beacon")
                } else {
                    None
                }
            } else {
                let claim_epoch = field(&body[2], "claim")
                    .and_then(|c| field(c, "epoch"))
                    .and_then(integer);
                if epoch.is_some_and(|n| n > HORIZON) || claim_epoch.is_some_and(|n| n > HORIZON) {
                    Some("malformed_term")
                } else if let Some((_, policy)) = policies
                    .iter()
                    .rev()
                    .find(|(id, _)| visible.contains(id.as_str()))
                {
                    let expected = map(vec![
                        ("version", Term::Integer(1)),
                        ("replica", bin(op.replica())),
                        ("epoch", body[1].clone()),
                        ("author", Term::Binary(op.author().to_vec())),
                        (
                            "deps",
                            Term::List(op.deps().iter().map(|id| bin(id)).collect()),
                        ),
                    ]);
                    if (Some(op.author()) != root
                        && !policy.witnesses.iter().any(|w| w.as_slice() == op.author()))
                        || !certificate(&body[2]).is_some_and(|c| {
                            beacon_claim(c.claim)
                                && verify(
                                    &c,
                                    &expected,
                                    &policy.witnesses,
                                    policy.threshold,
                                    "lattice-beacon-witness-v1",
                                )
                        })
                    {
                        Some("unauthorized_beacon")
                    } else if epoch.is_none() || prior.is_some_and(|p| epoch.unwrap() <= p) {
                        Some("stale_beacon")
                    } else if epoch.unwrap() as i128
                        > prior.map(i128::from).unwrap_or(-1) + policy.step as i128
                    {
                        Some("unauthorized_beacon")
                    } else {
                        None
                    }
                } else {
                    Some("unauthorized_beacon")
                }
            };
            if let Some(reason) = reason {
                self.reasons.insert(id.clone(), reason);
            } else {
                self.beacons.push((id.clone(), epoch.unwrap()));
            }
        }
    }
    fn continue_role(
        &self,
        op: &AuthenticFrame,
        role: &str,
        d: &Delegation,
        proof: &Term,
        timeline: &Timeline,
        pins: &[Pin],
    ) -> Result<u64, &'static str> {
        let dag = self.static_delegations.dag;
        let Term::Tuple(proof) = proof else {
            return Err("continuation_required");
        };
        if proof.first().and_then(atom) != Some("continuation_v1") {
            return Err("continuation_required");
        }
        if proof.len() != 2 {
            return Err("malformed_term");
        }
        let cert = certificate(&proof[1])
            .filter(|c| continuation_claim(c.claim))
            .ok_or("malformed_term")?;
        if d.expires.is_some_and(|n| n > HORIZON) {
            return Err("malformed_term");
        }
        let visible = dag.ancestors(op.id()).unwrap();
        let pin = pins
            .iter()
            .rev()
            .find(|pin| visible.contains(pin.op_id.as_str()))
            .ok_or("continuation_not_configured")?;
        let p = timeline
            .acquires
            .iter()
            .rev()
            .find(|p| visible.contains(p.op_id.as_str()))
            .ok_or("unauthorized_continuation")?;
        let previous = self
            .static_delegations
            .records()
            .get(&p.delegation_id)
            .and_then(|r| r.delegation.as_ref())
            .ok_or("unauthorized_continuation")?;
        if role != pin.profile.role
            || (op.author() != p.holder && op.author() != pin.profile.nominee)
            || d.issuer != op.author()
            || d.audience != op.author()
            || !d.roles.contains(role)
            || d.replica != op.replica()
            || !d.self_consistent()
        {
            return Err("unauthorized_continuation");
        }
        if d.roles.len() != 1
            || !d.ops.is_subset(&previous.ops)
            || d.live
            || d.parent.is_some()
            || d.expires.is_none()
        {
            return Err("continuation_scope_exceeded");
        }
        let epoch = self
            .beacons
            .iter()
            .filter(|(id, _)| visible.contains(id.as_str()))
            .map(|(_, e)| *e)
            .max()
            .filter(|e| *e <= HORIZON)
            .ok_or("invalid_continuation_epoch")?;
        let mut basis: Vec<_> = self
            .beacons
            .iter()
            .filter(|(id, e)| visible.contains(id.as_str()) && *e == epoch)
            .map(|(id, _)| bin(id))
            .collect();
        basis.sort_by(|a, b| binary(a).cmp(&binary(b)));
        if field(cert.claim, "epoch").and_then(integer) != Some(epoch)
            || field(cert.claim, "epoch_basis") != Some(&Term::List(basis.clone()))
        {
            return Err("invalid_continuation_epoch");
        }
        let expires = d.expires.unwrap();
        if expires < epoch || expires > epoch.saturating_add(pin.profile.width - 1).min(HORIZON) {
            return Err("continuation_scope_exceeded");
        }
        let mut supplied_deps = op.supplied_deps().to_vec();
        supplied_deps.sort();
        supplied_deps.dedup();
        let expected = map(vec![
            ("version", Term::Integer(1)),
            ("product", Term::Atom("treehouse".into())),
            ("kind", Term::Atom(pin.profile.kind.clone())),
            ("replica", bin(op.replica())),
            ("role", Term::Atom(role.into())),
            (
                "profile_id",
                bin(&digest("lattice-continuation-profile-v1", &pin.profile.term).unwrap()),
            ),
            ("profile_genesis", bin(&pin.op_id)),
            ("holder", Term::Binary(p.holder.clone())),
            ("holder_epoch", bin(&p.op_id)),
            ("successor", Term::Binary(d.audience.clone())),
            ("delegation_id", bin(&d.id)),
            ("author", Term::Binary(op.author().to_vec())),
            (
                "deps",
                Term::List(supplied_deps.iter().map(|id| bin(id)).collect()),
            ),
            ("epoch", Term::Integer(epoch)),
            ("epoch_basis", Term::List(basis)),
        ]);
        if !verify(
            &cert,
            &expected,
            &pin.profile.witnesses,
            pin.profile.threshold,
            "lattice-continuation-witness-v1",
        ) {
            return Err("invalid_continuation_certificate");
        }
        if timeline.acquires.last() != Some(p) {
            return Err("stale_continuation");
        }
        if self.static_delegations.revoked_as_of(op.id(), &d.id) == Some(true) {
            return Err("revoked_capability");
        }
        Ok(epoch)
    }
    pub fn timelines(&self) -> &BTreeMap<String, Timeline> {
        &self.timelines
    }
    pub fn beacons(&self) -> &[(String, u64)] {
        &self.beacons
    }
    pub fn reasons(&self) -> &BTreeMap<String, &'static str> {
        &self.reasons
    }
    /// Only the causal expiry component, never a complete command verdict.
    pub fn expired_as_of(&self, op_id: &str, delegation_id: &str) -> Option<bool> {
        let dag = self.static_delegations.dag;
        dag.frame(op_id)?;
        let mut current = Some(delegation_id);
        let mut seen = BTreeSet::new();
        let mut expires = None;
        while let Some(id) = current {
            if !seen.insert(id) {
                break;
            }
            let Some(d) = self
                .static_delegations
                .records()
                .get(id)
                .and_then(|r| r.delegation.as_ref())
            else {
                if id == delegation_id {
                    return None;
                }
                break;
            };
            if let Some(e) = d.expires {
                expires = Some(expires.map_or(e, |old: u64| old.min(e)));
            }
            current = d.parent.as_deref();
        }
        Some(expires.is_some_and(|expires| {
            self.beacons.iter().any(|(beacon, epoch)| {
                *epoch > expires && !dag.ancestors(beacon).unwrap().contains(op_id)
            })
        }))
    }
}
fn authority_body(op: &AuthenticFrame) -> Option<&[Term]> {
    if op.kind() != "authority" {
        return None;
    }
    if let Term::Tuple(body) = op.body() {
        Some(body)
    } else {
        None
    }
}
fn acquire(t: &mut Timeline, op: &AuthenticFrame, d: &Delegation, tick: u64) {
    t.acquires.push(Acquire {
        op_id: op.id().into(),
        holder: d.audience.clone(),
        delegation_id: d.id.clone(),
        at_tick: tick,
    });
}
fn proof_head(proof: &Term) -> bool {
    matches!(proof,Term::Tuple(v) if v.first().and_then(atom)==Some("continuation_v1"))
}
fn beacon_policy(term: &Term) -> Option<Policy> {
    let m = closed(
        term,
        &[
            "mode",
            "version",
            "witnesses",
            "threshold",
            "max_epoch_step",
        ],
    )?;
    let witnesses = witnesses(m["witnesses"])?;
    let threshold = integer(m["threshold"])?;
    let step = integer(m["max_epoch_step"])?;
    if atom(m["mode"]) != Some("witnessed")
        || integer(m["version"]) != Some(1)
        || threshold < 1
        || threshold > witnesses.len() as u64
        || !(1..=65535).contains(&step)
    {
        return None;
    }
    Some(Policy {
        witnesses,
        threshold,
        step,
    })
}
fn profile(term: &Term) -> Option<Profile> {
    let m = closed(
        term,
        &[
            "mode",
            "version",
            "product",
            "kind",
            "role",
            "nominee",
            "witnesses",
            "threshold",
            "max_lease_epochs",
        ],
    )?;
    let witnesses = witnesses(m["witnesses"])?;
    let threshold = integer(m["threshold"])?;
    let width = integer(m["max_lease_epochs"])?;
    if atom(m["mode"]) != Some("bounded_continuation")
        || integer(m["version"]) != Some(1)
        || atom(m["product"]) != Some("treehouse")
        || !kind_role(m["kind"], m["role"])
        || threshold < 1
        || threshold > witnesses.len() as u64
        || !(1..=65535).contains(&width)
    {
        return None;
    }
    let nominee = key(m["nominee"])?.to_vec();
    let mut normalized = term.clone();
    if let Term::Map(v) = &mut normalized {
        for (k, value) in v {
            if atom(k) == Some("witnesses") {
                *value = Term::List(witnesses.iter().cloned().map(Term::Binary).collect());
            }
        }
    }
    Some(Profile {
        term: normalized,
        kind: atom(m["kind"])?.into(),
        role: atom(m["role"])?.into(),
        nominee,
        witnesses,
        threshold,
        width,
    })
}
fn beacon_claim(term: &Term) -> bool {
    closed(term, &["version", "replica", "epoch", "author", "deps"]).is_some_and(|m| {
        integer(m["version"]) == Some(1)
            && binary(m["replica"]).is_some()
            && integer(m["epoch"]).is_some()
            && key(m["author"]).is_some()
            && list(m["deps"]).is_some_and(|v| v.iter().all(|t| binary(t).is_some()))
    })
}
fn continuation_claim(term: &Term) -> bool {
    closed(
        term,
        &[
            "version",
            "product",
            "kind",
            "replica",
            "role",
            "profile_id",
            "profile_genesis",
            "holder",
            "holder_epoch",
            "successor",
            "delegation_id",
            "author",
            "deps",
            "epoch",
            "epoch_basis",
        ],
    )
    .is_some_and(|m| {
        integer(m["version"]) == Some(1)
            && atom(m["product"]) == Some("treehouse")
            && kind_role(m["kind"], m["role"])
            && text(m["replica"]).is_some_and(|s| !s.is_empty())
            && [
                "profile_id",
                "profile_genesis",
                "holder_epoch",
                "delegation_id",
            ]
            .iter()
            .all(|k| id(m[k]))
            && ["holder", "successor", "author"]
                .iter()
                .all(|k| key(m[k]).is_some())
            && sorted_ids(m["deps"])
            && sorted_ids(m["epoch_basis"])
            && integer(m["epoch"]).is_some_and(|e| e <= HORIZON)
    })
}
