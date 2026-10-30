//! Causal Space application policy and deny-only member-continuity conflicts.
//! A layer verdict cannot establish installed catalog trust or route freshness.
use super::{
    bootstrap::Bootstrap,
    canonical::{base64, encode, Term},
    commands::{CommandPreflight, PrePolicyDecision},
    evidence_terms::*,
    frame::{self, AuthenticFrame},
    history::AuthenticDag,
    member_certificate::{Certificate, Claim},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::collections::{BTreeMap, BTreeSet};

type Reasons = BTreeMap<String, Option<&'static str>>;
pub struct SpacePolicy<'a> {
    pub(super) preflight: CommandPreflight<'a>,
    pub(super) reasons: Reasons,
}
impl<'a> SpacePolicy<'a> {
    pub fn analyze(dag: &'a AuthenticDag) -> Result<Self, &'static str> {
        if !dag.replica().starts_with("replica:treehouse:space:") {
            return Err("wrong_replica");
        }
        let preflight = CommandPreflight::analyze(dag)?;
        let mut reasons = BTreeMap::new();
        for id in dag.order() {
            let Some(decision) = preflight.decisions().get(id) else {
                continue;
            };
            let reason = match decision {
                PrePolicyDecision::Refused(reason) => Some(*reason),
                PrePolicyDecision::ApplicationPolicyRequired => {
                    let scope = dag.ancestors(id).expect("authenticated command");
                    application_reason(
                        id,
                        &Context {
                            dag,
                            preflight: &preflight,
                            reasons: &reasons,
                            scope: &scope,
                        },
                    )
                }
            };
            reasons.insert(id.clone(), reason);
        }
        let scope = dag.order().iter().map(String::as_str).collect();
        for (id, reason) in conflicts(&Context {
            dag,
            preflight: &preflight,
            reasons: &reasons,
            scope: &scope,
        }) {
            if reasons.get(&id) == Some(&None) {
                reasons.insert(id, Some(reason));
            }
        }
        Ok(Self { preflight, reasons })
    }
    /// No refusal at this layer does not mean catalog admission.
    pub fn command_reasons(&self) -> &Reasons {
        &self.reasons
    }
}

struct Context<'a, 'b> {
    dag: &'a AuthenticDag,
    preflight: &'b CommandPreflight<'a>,
    reasons: &'b Reasons,
    scope: &'b BTreeSet<&'a str>,
}
impl Context<'_, '_> {
    fn honored(&self, id: &str) -> bool {
        self.scope.contains(id)
            && if self.dag.frame(id).is_some_and(|op| op.kind() == "command") {
                self.reasons.get(id) == Some(&None)
            } else {
                !self.preflight.authority().reasons().contains_key(id)
            }
    }
    fn command(&self, id: &str, name: &str) -> Option<&[Term]> {
        self.scope
            .contains(id)
            .then(|| self.dag.frame(id))
            .flatten()
            .and_then(|op| args(op, name))
    }
    fn admissions(&self, key: &[u8]) -> Vec<&str> {
        self.scope
            .iter()
            .copied()
            .filter(|id| self.honored(id) && self.admission(id, key))
            .collect()
    }
    fn admission(&self, id: &str, key: &[u8]) -> bool {
        self.command(id, "admit_member")
            .is_some_and(|a| a.len() == 4 && text(&a[1]) == Some(STANDARD.encode(key).as_str()))
    }
    fn removed(&self, tag: &str, key: &[u8]) -> bool {
        self.scope.iter().any(|id| {
            self.honored(id)
                && self.removal(id, key)
                && self
                    .dag
                    .ancestors(id)
                    .expect("scoped operation")
                    .contains(tag)
        })
    }
    fn removal(&self, id: &str, key: &[u8]) -> bool {
        self.command(id, "remove_member")
            .is_some_and(|a| a.len() == 1 && text(&a[0]) == Some(STANDARD.encode(key).as_str()))
    }
    fn records(&self) -> Vec<(&str, Certificate<'_>)> {
        self.scope
            .iter()
            .filter(|id| self.honored(id))
            .filter_map(|id| certificate(self.dag, id).map(|cert| (*id, cert)))
            .collect()
    }
}
fn args<'a>(op: &'a AuthenticFrame, name: &str) -> Option<&'a [Term]> {
    if op.kind() != "command" {
        return None;
    }
    let Term::Tuple(body) = op.body() else {
        return None;
    };
    let [Term::Atom(command), Term::List(args)] = body.as_slice() else {
        return None;
    };
    (command == name).then_some(args)
}
fn claim<'a>(dag: &'a AuthenticDag, id: &str) -> Option<Claim<'a>> {
    let [claim, _, _] = args(dag.frame(id)?, "attest_member_key_v1")? else {
        return None;
    };
    Claim::decode(claim)
}
fn certificate<'a>(dag: &'a AuthenticDag, id: &str) -> Option<Certificate<'a>> {
    Certificate::decode_args(args(dag.frame(id)?, "attest_member_key_v1")?)
}
fn application_reason(id: &str, ctx: &Context<'_, '_>) -> Option<&'static str> {
    let op = ctx.dag.frame(id).expect("command");
    let command = ctx.preflight.command(id).expect("successful preflight");
    let a = command.args();
    match command.name() {
        "attest_member_key_v1" => continuity_reason(id, ctx),
        "catalog_bootstrap_v1" => {
            let valid = Bootstrap::decode(&a[0])
                .zip(ctx.preflight.authority().binding_at(id))
                .is_some_and(|(record, (root, pin, profile_id, kind))| {
                    record.space == op.replica()
                        && record.root == op.author()
                        && root == op.author()
                        && kind == "space"
                        && record.profile_genesis == pin
                        && record.profile_id == profile_id
                });
            (!valid).then_some("application_invalid_catalog")
        }
        "issue_invitation" => {
            let valid = text(&a[0]).is_some_and(|s| base64(s, Some(32)).is_ok())
                && scope_matches(&a[1], ctx);
            (!valid).then_some("application_invalid_invitation")
        }
        "revoke_invitation" | "admit_member" => {
            let target = text(&a[0]).expect("preflight text");
            if !ctx.scope.contains(target) {
                return Some("application_target_not_visible");
            }
            if !ctx.honored(target) {
                return Some("application_target_quarantined");
            }
            let Some(invite) = ctx
                .command(target, "issue_invitation")
                .filter(|v| v.len() == 2)
            else {
                return Some("application_wrong_target");
            };
            if command.name() == "revoke_invitation" {
                return None;
            }
            let recipient = text(&a[1]).expect("preflight text");
            let level = text(&a[2]).expect("preflight text");
            if text(&invite[0]) != Some(recipient)
                || !matches!(level, "member" | "moderator")
                || !scope_matches(&invite[1], ctx)
                || ctx.scope.iter().any(|id| {
                    ctx.honored(id)
                        && ctx
                            .command(id, "revoke_invitation")
                            .is_some_and(|v| v.len() == 1 && text(&v[0]) == Some(target))
                })
            {
                return Some("application_invalid_invitation");
            }
            let verified = base64(recipient, Some(32))
                .ok()
                .zip(text(&a[3]).and_then(|s| base64(s, Some(64)).ok()))
                .is_some_and(|(key, sig)| {
                    encode(&Term::List(vec![
                        bin("treehouse-invitation-acceptance-v1"),
                        bin(op.replica()),
                        bin(target),
                        invite[0].clone(),
                        invite[1].clone(),
                    ]))
                    .is_ok_and(|bytes| frame::verify_signature(&key, &bytes, &sig).is_ok())
                });
            (!verified).then_some("application_invalid_invitation")
        }
        _ => None,
    }
}
fn scope_matches(term: &Term, ctx: &Context<'_, '_>) -> bool {
    let actual: BTreeSet<_> = ctx
        .scope
        .iter()
        .filter(|id| ctx.honored(id))
        .filter_map(|id| {
            ctx.command(id, "create_thread")
                .and_then(|a| (a.len() == 2).then(|| text(&a[0])).flatten())
        })
        .collect();
    list(term)
        .and_then(|values| values.iter().map(text).collect::<Option<Vec<_>>>())
        .is_some_and(|supplied| supplied == actual.into_iter().collect::<Vec<_>>())
}
fn continuity_reason(id: &str, original: &Context<'_, '_>) -> Option<&'static str> {
    let Some(cert) = certificate(original.dag, id) else {
        return Some("application_invalid_continuity");
    };
    let c = &cert.claim;
    let op = original.dag.frame(id).expect("command");
    // Consent predicates compare the exact supplied envelope sequence in both
    // existing owners. Graph closure uses the normalized signed dependency set.
    if c.space != op.replica()
        || c.deps
            != op
                .supplied_deps()
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
    {
        return Some("application_invalid_continuity");
    }
    let mut effective = original.reasons.clone();
    for (id, reason) in conflicts(original) {
        effective.insert(id, Some(reason));
    }
    let ctx = Context {
        dag: original.dag,
        preflight: original.preflight,
        reasons: &effective,
        scope: original.scope,
    };
    let mut admissions = vec![(c.old_admission, c.old_pub)];
    admissions.extend(c.vouchers.iter().map(|v| (v.admission, v.member)));
    let targets: Vec<_> = admissions
        .iter()
        .map(|(id, _)| *id)
        .chain(c.epoch_basis.iter().copied())
        .collect();
    let groups: Vec<_> = c
        .parents
        .iter()
        .map(|parent| {
            ctx.scope
                .iter()
                .filter_map(|id| {
                    claim(ctx.dag, id)
                        .filter(|c| c.id().as_deref() == Some(*parent))
                        .map(|c| (*id, c))
                })
                .collect::<Vec<_>>()
        })
        .collect();
    if targets.iter().any(|id| !ctx.scope.contains(id)) || groups.iter().any(Vec::is_empty) {
        return Some("application_target_not_visible");
    }
    if targets.iter().any(|id| !ctx.honored(id))
        || groups
            .iter()
            .any(|g| !g.iter().any(|(id, _)| ctx.honored(id)))
    {
        return Some("application_target_quarantined");
    }
    if admissions.iter().any(|(id, key)| !ctx.admission(id, key))
        || c.epoch_basis.iter().any(|id| !ctx.dag.frame(id).is_some_and(|op| op.kind() == "authority"
            && matches!(op.body(), Term::Tuple(v) if matches!(v.as_slice(), [tag, _] | [tag, _, _] if atom(tag)==Some("beacon")))))
        || groups.iter().any(|g| !g.iter().any(|(id, parent)| ctx.honored(id) && parent.old_pub == c.old_pub)) {
        return Some("application_wrong_target");
    }
    let prior = ctx.records();
    let active = ctx
        .admissions(c.old_pub)
        .iter()
        .any(|id| !ctx.removed(id, c.old_pub));
    let parent_target = prior.iter().any(|(_, p)| {
        p.claim
            .id()
            .is_some_and(|id| c.parents.contains(&id.as_str()))
            && p.claim.old_pub == c.old_pub
            && p.claim.new_pub == c.new_pub
    });
    if active != c.active
        || c.vouchers
            .iter()
            .any(|v| ctx.removed(v.admission, v.member))
        || (!ctx.admissions(c.new_pub).is_empty() && !parent_target)
        || prior
            .iter()
            .any(|(_, p)| p.claim.old_pub != c.old_pub && p.claim.new_pub == c.new_pub)
    {
        return Some("application_continuity_ineligible_member");
    }
    let beacons: Vec<_> = ctx
        .preflight
        .authority()
        .beacons()
        .iter()
        .filter(|(id, _)| ctx.scope.contains(id.as_str()))
        .collect();
    let maximum = beacons.iter().map(|(_, epoch)| *epoch).max();
    let mut basis: Vec<_> = beacons
        .iter()
        .filter(|(_, epoch)| Some(*epoch) == maximum)
        .map(|(id, _)| id.as_str())
        .collect();
    basis.sort();
    if maximum != Some(c.epoch) || c.epoch_basis != basis {
        return Some("application_continuity_invalid_epoch");
    }
    if c.parents
        != heads(&prior, c.old_pub)
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
    {
        return Some("application_continuity_stale_context");
    }
    (!cert.verify()).then_some("application_continuity_invalid_certificate")
}
fn heads(records: &[(&str, Certificate<'_>)], old: &[u8]) -> Vec<String> {
    let claims: Vec<_> = records
        .iter()
        .filter(|(_, cert)| cert.claim.old_pub == old)
        .map(|(_, c)| &c.claim)
        .collect();
    let superseded: BTreeSet<_> = claims
        .iter()
        .flat_map(|c| c.parents.iter().copied())
        .collect();
    claims
        .iter()
        .filter_map(|c| c.id())
        .filter(|id| !superseded.contains(id.as_str()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
fn conflicts(ctx: &Context<'_, '_>) -> BTreeMap<String, &'static str> {
    let candidates: Vec<_> = ctx
        .dag
        .order()
        .iter()
        .filter(|id| ctx.honored(id))
        .filter_map(|id| certificate(ctx.dag, id).map(|c| (id.as_str(), c)))
        .collect();
    if candidates.is_empty() {
        return BTreeMap::new();
    }
    let removals: Vec<_> = ctx
        .scope
        .iter()
        .copied()
        .filter(|id| ctx.honored(id) && ctx.command(id, "remove_member").is_some())
        .collect();
    let ancestors: BTreeMap<_, _> = candidates
        .iter()
        .map(|(id, _)| *id)
        .chain(removals.iter().copied())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|id| (id, ctx.dag.ancestors(id).expect("scoped operation")))
        .collect();
    let claim_ids: BTreeMap<_, _> = candidates
        .iter()
        .map(|(id, cert)| (*id, cert.claim.id()))
        .collect();
    let concurrent =
        |a: &str, b: &str| a != b && !ancestors[a].contains(b) && !ancestors[b].contains(a);
    let mut denied = BTreeMap::new();
    for (id, cert) in &candidates {
        let stale = cert.claim.vouchers.iter().any(|v| {
            removals.iter().any(|removal| {
                ctx.removal(removal, v.member)
                    && concurrent(id, removal)
                    && ancestors[removal].contains(v.admission)
            })
        });
        let collision = candidates.iter().any(|(other, c)| {
            cert.claim.old_pub != c.claim.old_pub
                && cert.claim.new_pub == c.claim.new_pub
                && concurrent(id, other)
        });
        if stale {
            denied.insert((*id).into(), "application_continuity_stale_voucher");
        } else if collision {
            denied.insert((*id).into(), "application_continuity_conflicting_target");
        }
    }
    for (id, cert) in &candidates {
        let invalid = cert.claim.parents.iter().any(|parent| {
            !candidates.iter().any(|(wrapper, c)| {
                c.claim.old_pub == cert.claim.old_pub
                    && claim_ids[wrapper].as_deref() == Some(*parent)
                    && ancestors[id].contains(wrapper)
                    && !denied.contains_key(*wrapper)
            })
        });
        if invalid {
            denied
                .entry((*id).into())
                .or_insert("application_continuity_invalid_parent");
        }
    }
    denied
}
