//! Causal Thread application policy and projection after capability/role preflight.
//! This fold does not install catalog trust or grant route eligibility.
use super::{
    commands::{CommandPreflight, PrePolicyDecision},
    evidence_terms::text,
    history::AuthenticDag,
    projection::{heights, latest, Stamp},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, serde::Serialize)]
pub struct ThreadPost {
    pub id: String,
    pub author: String,
    pub text: String,
}

/// Public projection values, not an installation receipt or freshness proof.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadProjection {
    pub title: String,
    pub posts: Vec<ThreadPost>,
    pub moderation: Option<String>,
    pub archived: bool,
    pub moderator: Option<String>,
    pub command_reasons: BTreeMap<String, Option<&'static str>>,
}

fn preflight(dag: &AuthenticDag) -> Result<CommandPreflight<'_>, &'static str> {
    if !dag.replica().starts_with("replica:treehouse:thread:") {
        return Err("wrong_replica");
    }
    CommandPreflight::analyze(dag)
}

/// Command refusals in the complete authenticated Thread DAG. Authority is
/// judged by the existing preflight; application policy sees only causal past.
/// A `None` entry means no refusal at this layer, not final catalog admission.
pub fn analyze(dag: &AuthenticDag) -> Result<BTreeMap<String, Option<&'static str>>, &'static str> {
    let preflight = preflight(dag)?;
    Ok(fold(dag, &preflight))
}

fn fold(
    dag: &AuthenticDag,
    preflight: &CommandPreflight<'_>,
) -> BTreeMap<String, Option<&'static str>> {
    let mut decisions = BTreeMap::new();
    for id in dag.order() {
        let Some(decision) = preflight.decisions().get(id) else {
            continue;
        };
        let reason = match decision {
            PrePolicyDecision::Refused(reason) => Some(*reason),
            PrePolicyDecision::ApplicationPolicyRequired => {
                application_reason(dag, preflight, id, &decisions)
            }
        };
        decisions.insert(id.clone(), reason);
    }
    decisions
}

/// Reduce honored Thread effects with the source CRDT order. Edits preserve the
/// original post identity and position; deletions remove presentation only.
pub fn project(dag: &AuthenticDag) -> Result<ThreadProjection, &'static str> {
    let preflight = preflight(dag)?;
    let decisions = fold(dag, &preflight);
    let depths = heights(dag);
    let mut posts = BTreeMap::new();
    let mut edits: BTreeMap<&str, Option<(Stamp<'_>, &str)>> = BTreeMap::new();
    let mut deleted = BTreeSet::new();
    let mut title = None;
    let mut moderation = None;
    let mut archived = false;
    for id in dag.order() {
        let depth = depths[id.as_str()];
        if decisions.get(id) != Some(&None) {
            continue;
        }
        let command = preflight.command(id).expect("successful command preflight");
        let arg = |index| text(&command.args()[index]).expect("preflight text argument");
        let stamp = (depth, id.as_str());
        match command.name() {
            "create_thread" => {
                latest(&mut title, stamp, arg(0));
                latest(&mut moderation, stamp, "create_thread");
            }
            "post" => {
                posts.insert(id.as_str(), (stamp, arg(0)));
            }
            "author_edit" => {
                latest(edits.entry(arg(0)).or_default(), stamp, arg(2));
            }
            "author_tombstone" | "moderator_tombstone" => {
                deleted.insert(arg(0));
                if command.name() == "moderator_tombstone" {
                    latest(&mut moderation, stamp, arg(0));
                }
            }
            "archive_thread" => {
                archived = true;
            }
            _ => unreachable!("closed Thread command table"),
        }
    }
    let mut visible: Vec<_> = posts
        .into_iter()
        .filter(|(id, _)| !deleted.contains(id))
        .collect();
    visible.sort_by_key(|(_, (stamp, _))| *stamp);
    let posts = visible
        .into_iter()
        .map(|(id, (_, original))| ThreadPost {
            id: id.into(),
            author: STANDARD.encode(dag.frame(id).expect("original signed post").author()),
            text: edits
                .get(id)
                .and_then(|edit| *edit)
                .map_or(original, |(_, value)| value)
                .into(),
        })
        .collect();
    let moderator = preflight
        .authority()
        .timelines()
        .get("moderator")
        .and_then(|timeline| timeline.acquires().last())
        .map(|acquire| STANDARD.encode(acquire.holder()));
    Ok(ThreadProjection {
        title: title.map_or("", |(_, value)| value).into(),
        posts,
        moderation: moderation.map(|(_, value)| value.into()),
        archived,
        moderator,
        command_reasons: decisions,
    })
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
