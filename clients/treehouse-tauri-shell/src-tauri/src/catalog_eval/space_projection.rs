//! Pure Space CRDT values after full application policy. No stored trust receipt.
use super::{
    evidence_terms::text,
    history::AuthenticDag,
    projection::{heights, latest},
    space_policy::SpacePolicy,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Serialize)]
pub struct SpaceState {
    pub name: String,
    pub members: Vec<String>,
    pub threads: Vec<Value>,
    pub invitations: Vec<Value>,
    pub revoked_invitations: Vec<String>,
    pub membership_events: Vec<Value>,
    pub admin_actions: Option<String>,
    pub moderator_actions: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceProjection {
    pub state: SpaceState,
    pub holders: BTreeMap<String, Option<String>>,
    pub initialization: &'static str,
    pub command_reasons: BTreeMap<String, Option<&'static str>>,
}

pub fn project(dag: &AuthenticDag) -> Result<SpaceProjection, &'static str> {
    let policy = SpacePolicy::analyze(dag)?;
    let depths = heights(dag);
    let mut name = None;
    let mut admin = None;
    let mut additions: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut removed = BTreeSet::new();
    let mut threads = BTreeSet::new();
    let mut invitations = Vec::new();
    let mut revoked = BTreeSet::new();
    let mut events = Vec::new();
    let mut ready = false;
    let roots: BTreeSet<_> = dag.order().iter().filter(|id| !policy.preflight.authority().reasons().contains_key(id.as_str()))
        .filter(|id| dag.frame(id).is_some_and(|op| op.kind()=="authority"
            && matches!(op.body(), super::canonical::Term::Tuple(v) if matches!(v.as_slice(),[tag,delegation,_] if super::evidence_terms::atom(tag)==Some("genesis") && super::delegations::Delegation::decode(delegation).is_some()))))
        .map(String::as_str).collect();
    for id in dag.order() {
        if policy.reasons.get(id) != Some(&None) {
            continue;
        }
        let op = dag.frame(id).expect("command");
        let command = policy.preflight.command(id).expect("successful preflight");
        let arg = |i: usize| text(&command.args()[i]).expect("preflight text");
        let stamp = (depths[id.as_str()], id.as_str());
        latest(&mut admin, stamp, command.name());
        match command.name() {
            "create_space" => {
                latest(&mut name, stamp, arg(0));
                if op.supplied_deps().len() == 1 && roots.contains(op.supplied_deps()[0].as_str()) {
                    ready = true;
                }
            }
            "create_thread" => {
                threads.insert((arg(0), arg(1)));
            }
            "issue_invitation" => {
                let scope = super::evidence_terms::list(&command.args()[1])
                    .expect("preflight list")
                    .iter()
                    .map(|v| text(v).expect("text scope"))
                    .collect::<Vec<_>>();
                invitations.push((stamp, json!({"recipient":arg(0),"threads":scope})));
            }
            "revoke_invitation" => {
                revoked.insert(arg(0));
            }
            "admit_member" => {
                additions.entry(arg(1)).or_default().push(id);
                events.push((
                    stamp,
                    json!({"action":"admit","invitation":arg(0),"recipient":arg(1),"level":arg(2)}),
                ));
            }
            "remove_member" => {
                let visible = dag.ancestors(id).expect("authenticated command");
                for tag in additions.get(arg(0)).into_iter().flatten() {
                    if visible.contains(*tag) {
                        removed.insert(*tag);
                    }
                }
                events.push((stamp, json!({"action":"remove","recipient":arg(0)})));
            }
            "catalog_bootstrap_v1" | "attest_member_key_v1" => {}
            _ => unreachable!("closed Space command table"),
        }
    }
    invitations.sort_by_key(|(stamp, _)| *stamp);
    events.sort_by_key(|(stamp, _)| *stamp);
    let holders = policy
        .preflight
        .authority()
        .timelines()
        .iter()
        .map(|(role, t)| {
            (
                role.clone(),
                t.acquires()
                    .last()
                    .map(|acquire| STANDARD.encode(acquire.holder())),
            )
        })
        .collect();
    Ok(SpaceProjection {
        state: SpaceState {
            name: name.map_or("", |(_, value)| value).into(),
            members: additions
                .into_iter()
                .filter(|(_, tags)| tags.iter().any(|tag| !removed.contains(tag)))
                .map(|(member, _)| member.into())
                .collect(),
            threads: threads
                .into_iter()
                .map(|(replica, title)| json!({"replica":replica,"title":title}))
                .collect(),
            invitations: invitations.into_iter().map(|(_, value)| value).collect(),
            revoked_invitations: revoked.into_iter().map(str::to_owned).collect(),
            membership_events: events.into_iter().map(|(_, value)| value).collect(),
            admin_actions: admin.map(|(_, value)| value.into()),
            moderator_actions: None,
        },
        holders,
        initialization: if ready {
            "ready"
        } else if roots.is_empty() {
            "uninitialized"
        } else {
            "incomplete"
        },
        command_reasons: policy.reasons,
    })
}
