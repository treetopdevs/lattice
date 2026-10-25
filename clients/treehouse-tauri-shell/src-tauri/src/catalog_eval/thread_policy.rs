//! Causal Thread application policy after command/capability/role preflight.
//! This fold does not install catalog trust or grant route eligibility.
use super::{
    commands::{CommandPreflight, PrePolicyDecision},
    evidence_terms::text,
    history::AuthenticDag,
};
use std::collections::{BTreeMap, BTreeSet};

/// Command refusals in the complete authenticated Thread DAG. Authority is
/// judged by the existing preflight; application policy sees only causal past.
pub fn analyze(dag: &AuthenticDag) -> Result<BTreeMap<String, Option<&'static str>>, &'static str> {
    if !dag.replica().starts_with("replica:treehouse:thread:") {
        return Err("wrong_replica");
    }
    let preflight = CommandPreflight::analyze(dag)?;
    let mut decisions = BTreeMap::new();
    for id in dag.order() {
        let Some(decision) = preflight.decisions().get(id) else {
            continue;
        };
        let reason = match decision {
            PrePolicyDecision::Refused(reason) => Some(*reason),
            PrePolicyDecision::ApplicationPolicyRequired => {
                application_reason(dag, &preflight, id, &decisions)
            }
        };
        decisions.insert(id.clone(), reason);
    }
    Ok(decisions)
}

fn application_reason(
    dag: &AuthenticDag,
    preflight: &CommandPreflight<'_>,
    id: &str,
    decisions: &BTreeMap<String, Option<&'static str>>,
) -> Option<&'static str> {
    let current = preflight.command(id).expect("successful command preflight");
    let visible = dag.ancestors(id).expect("authenticated command");
    let honored = |prior: &str| {
        if dag
            .frame(prior)
            .is_some_and(|frame| frame.kind() == "command")
        {
            decisions.get(prior) == Some(&None)
        } else {
            !preflight.authority().reasons().contains_key(prior)
        }
    };
    let archived = || {
        visible.iter().any(|prior| {
            honored(prior)
                && preflight
                    .command(prior)
                    .is_some_and(|c| c.name() == "archive_thread")
        })
    };
    if current.name() == "post" {
        return archived().then_some("application_archived_thread");
    }
    if !matches!(
        current.name(),
        "author_edit" | "author_tombstone" | "moderator_tombstone"
    ) {
        return None;
    }
    // Syntax preflight requires UTF-8 ids; preserve their literal code points.
    let post = text(&current.args()[0]).expect("preflight lineage id");
    let mut next = text(&current.args()[1]).expect("preflight lineage id");
    let mut targets = BTreeSet::from([post]);
    while targets.insert(next) {
        let Some(command) = visible
            .contains(next)
            .then(|| preflight.command(next))
            .flatten()
        else {
            break;
        };
        if command.name() != "author_edit" || text(&command.args()[0]) != Some(post) {
            break;
        }
        next = text(&command.args()[1]).expect("preflight edit target");
    }
    let target_ids = targets;
    if target_ids.iter().any(|id| !visible.contains(id)) {
        return Some("application_target_not_visible");
    }
    if target_ids.iter().any(|id| !honored(id)) {
        return Some("application_target_quarantined");
    }
    let post_id = post;
    if !preflight
        .command(post_id)
        .is_some_and(|c| c.name() == "post")
        || target_ids.iter().any(|id| {
            *id != post_id
                && !preflight
                    .command(id)
                    .is_some_and(|c| c.name() == "author_edit" && text(&c.args()[0]) == Some(post))
        })
    {
        return Some("application_wrong_target");
    }
    if current.name() != "moderator_tombstone"
        && dag.frame(post_id).expect("visible post").author()
            != dag.frame(id).expect("command").author()
    {
        return Some("application_wrong_author");
    }
    if visible.iter().any(|prior| {
        honored(prior)
            && preflight.command(prior).is_some_and(|c| {
                matches!(c.name(), "author_tombstone" | "moderator_tombstone")
                    && text(&c.args()[0]) == Some(post)
            })
    }) {
        return Some("application_already_tombstoned");
    }
    (current.name() != "moderator_tombstone" && archived()).then_some("application_archived_thread")
}
