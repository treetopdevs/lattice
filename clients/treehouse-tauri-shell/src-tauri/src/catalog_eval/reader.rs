//! Product-reader portability of an already authenticated frame. This proof is
//! narrower than semantic normalization: no payload, policy, honor or route is
//! inferred. Cutoff observation must still precede this stage for incoming trust.
use super::frame::{self, AuthenticFrame};
use serde_json::Value;
use std::{collections::BTreeSet, sync::LazyLock};

// Full carrier vocabulary, distinct from the smaller portable catalog-cutoff
// vocabulary. Reciprocal tests compare every current owner name.
const WIRE_NAMES: &str =
    "__beacon__ __continuation__ abort_election accept active admin admin_actions admission admit
    admit_member archive_thread archived attest_close attest_member_key_v1 audience author
    author_edit author_tombstone authority bad_signature beacon binding bootstrap
    bounded_continuation bounded_space_admin_v1 bulletin bytes cap catalog catalog_bootstrap_v1
    catalog_key certify_close claim clerk clerk_locked? close_clerk close_matter close_mayor
    command condition_notes configure_election consent continuation_v1 create_space
    create_thread creation custody custody_transfer cutoffs delegation_id delete_message
    delist_tool delivered deny deps describe description dormant_ticks drop_neighbor enrollment
    entries epoch epoch_basis events expires_epoch extra frontier generation genesis get ghost
    grant heartbeat holder holder_epoch id inbox inventory inventory_digest invitations
    issue_invitation issuer join kind leave link_election list_tool live lock locked? log_digest
    malformed manage max_epoch_step max_lease_epochs mayor mayor_locked? member members
    membership_events message messages mode moderation moderator moderator_actions
    moderator_tombstone name neighbors nested new_catalog_key new_origin new_pub new_service_id
    new_service_key new_signature nominee nonce not_granted note_condition notes old_admission
    old_membership old_pub old_signature open_election ops origin parent parent_id parents
    participants policy_id post post_bulletin posts previous prior_catalog prior_catalogs
    product profile_genesis profile_id propose_close publish_box_seal publish_protocol_artifact
    publish_roster publish_setup publish_tally reason recovery reference reject remove_member
    removed reopen_matter replace_catalog_v1 replacement_rule replica request response revision
    revoke revoke_invitation revoked_invitations role roles root rotation route schema
    seize_records service service_id service_key set_name set_summary set_title sig signature
    signatures source space space_root state steward submit_ballot succeed successor summary
    thread threads threshold title tombstone transfer treehouse treehouse_space_v1
    treehouse_thread_v1 undeclared unlock version vouch_in vouchers witness witnessed witnesses";
fn known_atom(name: &str) -> bool {
    static NAMES: LazyLock<BTreeSet<&str>> =
        LazyLock::new(|| WIRE_NAMES.split_whitespace().collect());
    NAMES.contains(name)
}

const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
pub struct ReadableFrame(AuthenticFrame);
impl ReadableFrame {
    pub fn verify(bytes: &[u8]) -> Result<Self, &'static str> {
        let frame = frame::verify(bytes)?;
        // Preserve numeric-vs-text and null-vs-absent distinctions erased by
        // canonical terms. Authentication and the existing frame cap run first.
        let raw = super::json::parse(bytes)?;
        if !body_readable(&raw) || !readable(&raw["cap"], Context::Strict) {
            return Err("unsupported_cutoff");
        }
        Ok(Self(frame))
    }
    pub fn frame(&self) -> &AuthenticFrame {
        &self.0
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Context {
    Strict,
    Metadata,
    Certificate,
    Claim,
}
fn atom(term: &Value, name: &str) -> bool {
    term[0] == "atom" && term[1] == name
}
fn body_readable(frame: &Value) -> bool {
    let body = &frame["body"];
    if frame["kind"] == "authority" && body[0] == "tuple" {
        let values = body[1].as_array().expect("authenticated tuple");
        match values.as_slice() {
            [tag, epoch] if atom(tag, "beacon") && epoch[0] == "int" => return true,
            [tag, epoch, certificate] if atom(tag, "beacon") => {
                return readable(epoch, Context::Strict)
                    && readable(certificate, Context::Certificate);
            }
            [tag, delegation, policies] if atom(tag, "genesis") && policies[0] == "map" => {
                return readable(delegation, Context::Strict)
                    && policies[1]
                        .as_array()
                        .expect("authenticated map")
                        .iter()
                        .all(|pair| {
                            readable(&pair[0], Context::Strict)
                                && readable(
                                    &pair[1],
                                    if atom(&pair[0], "__beacon__") {
                                        Context::Metadata
                                    } else {
                                        Context::Strict
                                    },
                                )
                        });
            }
            _ => {}
        }
    }
    readable(body, Context::Strict)
}
fn readable(term: &Value, context: Context) -> bool {
    let child = if context == Context::Strict {
        Context::Strict
    } else {
        Context::Metadata
    };
    match term[0].as_str().expect("authenticated term tag") {
        "nil" | "bool" | "bin" => true,
        "int" => {
            let value = term[1]
                .as_u64()
                .or_else(|| term[1].as_str()?.parse::<u64>().ok())
                .expect("authenticated integer");
            value <= MAX_SAFE || context != Context::Strict
        }
        "atom" => known_atom(term[1].as_str().expect("authenticated atom")),
        "list" | "tuple" | "mapset" => term[1]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| readable(v, child)),
        "map" => term[1].as_array().unwrap().iter().all(|pair| {
            let key = &pair[0];
            let value = &pair[1];
            let value_context = if context == Context::Certificate && atom(key, "claim") {
                Context::Claim
            } else if context == Context::Claim && atom(key, "epoch") && value[0] == "int" {
                Context::Strict
            } else {
                child
            };
            readable(key, child) && readable(value, value_context)
        }),
        "delegation" => {
            let record = &term[1];
            ["ops", "roles"].iter().all(|field| {
                record[field]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|v| known_atom(v.as_str().unwrap()))
            }) && record
                .get("expires_epoch")
                .is_none_or(|v| v.as_u64().is_some_and(|n| n <= MAX_SAFE))
        }
        _ => false,
    }
}
