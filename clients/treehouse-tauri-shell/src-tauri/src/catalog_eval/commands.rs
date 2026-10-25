//! Treehouse command syntax and pre-policy capability/role checks. A successful
//! preflight still requires application policy, semantic projection and catalog
//! trust; this component cannot report a command honored or authorize a route.
use super::{
    authority::AuthorityEvidence,
    canonical::{base64, Term},
    delegations::Validation,
    evidence_terms::{binary, text},
    frame::AuthenticFrame,
    history::AuthenticDag,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Product {
    Space,
    Thread,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PrePolicyDecision {
    Refused(&'static str),
    ApplicationPolicyRequired,
}

#[derive(Debug)]
pub struct Command<'a> {
    name: &'a str,
    args: &'a [Term],
    fields: &'static [&'static str],
    roles: &'static [&'static str],
}
impl<'a> Command<'a> {
    pub fn name(&self) -> &str {
        self.name
    }
    /// Raw authenticated terms, not a completed semantic/application projection.
    pub fn args(&self) -> &[Term] {
        self.args
    }
    pub fn fields(&self) -> &[&str] {
        self.fields
    }
    pub fn roles(&self) -> &[&str] {
        self.roles
    }
    fn decode(product: Product, frame: &'a AuthenticFrame) -> Result<Self, &'static str> {
        let Term::Tuple(body) = frame.body() else {
            return Err("malformed_command");
        };
        let [command, Term::List(args)] = body.as_slice() else {
            return Err("malformed_command");
        };
        let name = match command {
            Term::Nil => return Err("malformed_command"),
            Term::Atom(name) => name,
            _ => return Err("unknown_command"),
        };
        let (arity, fields, roles): (_, &'static [&'static str], &'static [&'static str]) =
            match (product, name.as_str()) {
                (Product::Space, "create_space") => (1, &["name", "admin_actions"], &["admin"]),
                (Product::Space, "create_thread") => (2, &["threads", "admin_actions"], &["admin"]),
                (Product::Space, "issue_invitation") => {
                    (2, &["invitations", "admin_actions"], &["admin"])
                }
                (Product::Space, "revoke_invitation") => {
                    (1, &["revoked_invitations", "admin_actions"], &["admin"])
                }
                (Product::Space, "admit_member") => (
                    4,
                    &["members", "membership_events", "admin_actions"],
                    &["admin"],
                ),
                (Product::Space, "remove_member") => (
                    1,
                    &["members", "membership_events", "admin_actions"],
                    &["admin"],
                ),
                (Product::Space, "catalog_bootstrap_v1") => (1, &["admin_actions"], &["admin"]),
                (Product::Space, "attest_member_key_v1") => (3, &["admin_actions"], &["admin"]),
                (Product::Thread, "create_thread") => (1, &["title", "moderation"], &["moderator"]),
                (Product::Thread, "post") => (1, &["posts"], &[]),
                (Product::Thread, "author_edit") => (3, &["posts"], &[]),
                (Product::Thread, "author_tombstone") => (2, &["posts"], &[]),
                (Product::Thread, "moderator_tombstone") => {
                    (2, &["posts", "moderation"], &["moderator"])
                }
                (Product::Thread, "archive_thread") => (0, &["archived"], &["moderator"]),
                _ => return Err("unknown_command"),
            };
        if args.len() != arity {
            return Err("bad_command_arity");
        }
        let valid = match name.as_str() {
            // These commands have an opaque wire payload at the effects stage.
            // Their closed certificates/records belong to application policy.
            "catalog_bootstrap_v1" | "attest_member_key_v1" => true,
            "issue_invitation" => {
                text(&args[0]).is_some()
                    && matches!(&args[1],Term::List(v) if v.iter().all(|v|text(v).is_some()))
            }
            "remove_member" => text(&args[0]).is_some_and(|s| base64(s, Some(32)).is_ok()),
            // The raw BEAM effects guard treats lineage ids as binary. Their
            // causal target and the TS structural/value boundary are later gates.
            "author_edit" => {
                binary(&args[0]).is_some() && binary(&args[1]).is_some() && text(&args[2]).is_some()
            }
            "author_tombstone" | "moderator_tombstone" => {
                binary(&args[0]).is_some() && binary(&args[1]).is_some()
            }
            "create_thread" if product == Product::Space => {
                text(&args[0]).is_some_and(|s| !s.is_empty()) && text(&args[1]).is_some()
            }
            _ => args.iter().all(|arg| text(arg).is_some()),
        };
        if !valid {
            return Err("malformed_command");
        }
        Ok(Self {
            name,
            args,
            fields,
            roles,
        })
    }
}

#[derive(Debug)]
pub struct CommandPreflight<'a> {
    authority: AuthorityEvidence<'a>,
    commands: BTreeMap<String, Command<'a>>,
    decisions: BTreeMap<String, PrePolicyDecision>,
}
impl<'a> CommandPreflight<'a> {
    /// Raw BEAM command/effects grammar and shared pre-policy predicates. The
    /// final incoming TS structural normalization remains a separate boundary.
    pub fn analyze(dag: &'a AuthenticDag) -> Result<Self, &'static str> {
        let authority = AuthorityEvidence::analyze(dag)?;
        let product = if dag.replica().starts_with("replica:treehouse:space:") {
            Product::Space
        } else {
            Product::Thread
        };
        let mut commands = BTreeMap::new();
        let mut decisions = BTreeMap::new();
        for id in dag.order() {
            let frame = dag.frame(id).expect("authenticated order");
            if frame.kind() != "command" {
                continue;
            }
            let decision = match Command::decode(product, frame) {
                Err(reason) => PrePolicyDecision::Refused(reason),
                Ok(command) => {
                    let reason = pre_policy_reason(&authority, frame, &command);
                    commands.insert(id.clone(), command);
                    reason
                        .map(PrePolicyDecision::Refused)
                        .unwrap_or(PrePolicyDecision::ApplicationPolicyRequired)
                }
            };
            decisions.insert(id.clone(), decision);
        }
        Ok(Self {
            authority,
            commands,
            decisions,
        })
    }
    pub fn command(&self, id: &str) -> Option<&Command<'a>> {
        self.commands.get(id)
    }
    pub fn decisions(&self) -> &BTreeMap<String, PrePolicyDecision> {
        &self.decisions
    }
    pub fn authority(&self) -> &AuthorityEvidence<'a> {
        &self.authority
    }
}

fn pre_policy_reason(
    authority: &AuthorityEvidence<'_>,
    op: &AuthenticFrame,
    command: &Command<'_>,
) -> Option<&'static str> {
    let records = authority.static_delegations.records();
    let Some((cap_id, record)) =
        text(op.cap()).and_then(|id| records.get(id).map(|record| (id, record)))
    else {
        return Some("no_capability");
    };
    let Some(d) = &record.delegation else {
        return Some("invalid_capability");
    };
    if d.replica != op.replica() {
        return Some("wrong_replica");
    }
    let dag = authority.static_delegations.dag;
    let visible = dag.ancestors(op.id()).expect("retained command");
    let valid = match record.validation() {
        Validation::Valid => true,
        Validation::SuccessionCandidate(root) => authority.timelines().values().any(|timeline| {
            timeline
                .acquires()
                .iter()
                .any(|acquire| acquire.delegation_id == *root && visible.contains(acquire.op_id()))
        }),
        _ => false,
    };
    if !valid {
        return Some("invalid_capability");
    }
    if d.audience != op.author() {
        return Some("capability_wrong_audience");
    }
    if !d.ops.contains(command.name()) {
        return Some("operation_not_granted");
    }
    if !record
        .introductions()
        .iter()
        .any(|id| visible.contains(id.as_str()))
    {
        return Some("capability_not_visible");
    }
    if !command.roles.iter().all(|role| d.roles.contains(*role)) {
        return Some("role_not_granted");
    }
    if authority.static_delegations.revoked_as_of(op.id(), cap_id) == Some(true) {
        return Some("revoked_capability");
    }
    if authority.expired_as_of(op.id(), cap_id) == Some(true) {
        return Some("lease_expired");
    }
    for role in command.roles() {
        let Some(timeline) = authority.timelines().get(*role) else {
            return Some("not_holder");
        };
        let predecessor = timeline
            .acquires()
            .iter()
            .enumerate()
            .rev()
            .find(|(_, a)| visible.contains(a.op_id()));
        let Some((index, predecessor)) = predecessor else {
            return Some("not_holder");
        };
        if predecessor.holder() != op.author() {
            return Some("not_holder");
        }
        if let Some(next) = timeline.acquires().get(index + 1) {
            if !dag
                .ancestors(next.op_id())
                .expect("retained acquisition")
                .contains(op.id())
            {
                return Some("stale_holder");
            }
        }
    }
    None
}
