//! Exact portable recovery-cutoff observation of complete raw evidence.
//! Integrity and portability only: no authority, freshness or installed trust.
use super::{
    canonical::{self, Term},
    frame, json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::{self, Write},
    sync::LazyLock,
};

const INVALID: &str = "invalid_verified_history";
const UNSUPPORTED: &str = "unsupported_cutoff";
const MAX_SAFE: u64 = super::canonical::MAX_SAFE_INTEGER;
const ATOMS: &str =
    "__beacon__ __continuation__ accept active admin admin_actions admission admit_member
    archive_thread archived attest_member_key_v1 audience author author_edit author_tombstone
    authority bad_signature beacon binding bootstrap bounded_continuation
    bounded_space_admin_v1 bytes cap catalog catalog_bootstrap_v1 catalog_key claim command
    consent continuation_v1 create_space create_thread creation cutoffs delegation_id deps
    dormant_ticks entries epoch epoch_basis expires_epoch frontier generation genesis grant
    heartbeat holder holder_epoch id inbox inventory_digest invitations issue_invitation
    issuer kind live log_digest max_epoch_step max_lease_epochs member members
    membership_events mode moderation moderator moderator_actions moderator_tombstone name
    new_catalog_key new_origin new_pub new_service_id new_service_key new_signature nominee
    nonce old_admission old_membership old_pub old_signature ops origin parent parent_id
    parents policy_id post posts previous prior_catalog prior_catalogs product profile_genesis
    profile_id reason recovery reference reject remove_member removed replace_catalog_v1
    replacement_rule replica request revision revoke revoke_invitation revoked_invitations
    role roles root rotation route schema service service_id service_key sig signature
    signatures space space_root succeed successor thread threads threshold title tombstone
    transfer treehouse treehouse_space_v1 treehouse_thread_v1 version vouchers witness
    witnessed witnesses";

#[derive(Debug, PartialEq, Eq)]
pub struct CutoffError {
    pub reason: &'static str,
}
fn error(reason: &'static str) -> CutoffError {
    CutoffError { reason }
}

#[derive(Debug)]
struct Record {
    id: String,
    payload: Vec<u8>,
    signature: Vec<u8>,
}
#[derive(Debug)]
pub struct CutoffObservation {
    replica: String,
    frontier: Vec<String>,
    log_digest: String,
    canonical_bytes: Vec<u8>,
}
impl CutoffObservation {
    pub fn replica(&self) -> &str {
        &self.replica
    }
    pub fn frontier(&self) -> &[String] {
        &self.frontier
    }
    pub fn log_digest(&self) -> &str {
        &self.log_digest
    }
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.canonical_bytes
    }
}

/// Consume a closed {replica, frames, rejected} history through bounded JSON.
/// Retained bad-signature records stay separate even when an accepted op shares
/// their supplied id. They cannot close accepted dependencies or gain authority.
pub fn derive(bytes: &[u8]) -> Result<CutoffObservation, CutoffError> {
    if bytes.len() > canonical::MAX_OBSERVATION_INPUT {
        return Err(error(UNSUPPORTED));
    }
    let raw = json::parse_observation(bytes).map_err(|reason| {
        error(if reason == "observation_limit" {
            UNSUPPORTED
        } else {
            INVALID
        })
    })?;
    derive_value(&raw)
}

// The retained union already owns and accounts parsed observations. Do not
// serialize it through a single external transport limit a second time.
pub(super) fn derive_value(raw: &Value) -> Result<CutoffObservation, CutoffError> {
    if !closed(raw, &["replica", "frames", "rejected"]) {
        return Err(error(INVALID));
    }
    let replica = raw["replica"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| error(INVALID))?;
    let frames = raw["frames"].as_array().ok_or_else(|| error(INVALID))?;
    let rejected = raw["rejected"].as_array().ok_or_else(|| error(INVALID))?;
    let mut accepted_ids = BTreeSet::new();
    let mut rejected_ids = BTreeSet::new();
    for value in frames {
        if !header(value, replica) || !accepted_ids.insert(value["id"].as_str().unwrap()) {
            return Err(error(INVALID));
        }
    }
    for item in rejected {
        if !closed(item, &["frame", "reason"])
            || item["reason"] != "bad_signature"
            || item["frame"]["replica"].as_str() != Some(replica)
        {
            return Err(error(INVALID));
        }
        let id = item["frame"]["id"].as_str().ok_or_else(|| error(INVALID))?;
        if !rejected_ids.insert(id) {
            return Err(error(INVALID));
        }
    }
    let mut referenced = BTreeSet::new();
    for value in frames {
        for dep in value["deps"].as_array().unwrap() {
            let id = dep.as_str().unwrap();
            if !accepted_ids.contains(id) {
                return Err(error(INVALID));
            }
            referenced.insert(id);
        }
    }
    let frontier = accepted_ids
        .difference(&referenced)
        .map(|id| (*id).to_owned())
        .collect();
    let mut ops = Vec::new();
    let mut refusals = Vec::new();
    let mut unsupported = false;
    for (values, accepted) in [
        (frames.iter().collect::<Vec<_>>(), true),
        (rejected.iter().map(|item| &item["frame"]).collect(), false),
    ] {
        for value in values {
            match inspect(value, replica, accepted) {
                Ok(Some(record)) => {
                    if accepted {
                        ops.push(record);
                    } else {
                        refusals.push(record);
                    }
                }
                Ok(None) => unsupported = true,
                Err(failure) => return Err(failure),
            }
        }
    }
    if unsupported {
        return Err(error(UNSUPPORTED));
    }
    ops.sort_by(|a, b| a.id.cmp(&b.id));
    refusals.sort_by(|a, b| a.id.cmp(&b.id));
    let term = Term::List(vec![
        Term::Binary(b"lattice-treehouse-recovery-cutoff-v1".to_vec()),
        Term::Binary(replica.as_bytes().to_vec()),
        Term::List(ops.into_iter().map(|op| record(op, false)).collect()),
        Term::List(refusals.into_iter().map(|op| record(op, true)).collect()),
    ]);
    let canonical_bytes = canonical::encode_observation(&term).map_err(|_| error(UNSUPPORTED))?;
    let log_digest = URL_SAFE_NO_PAD.encode(Sha256::digest(&canonical_bytes));
    Ok(CutoffObservation {
        replica: replica.to_owned(),
        frontier,
        log_digest,
        canonical_bytes,
    })
}

fn inspect(raw: &Value, replica: &str, accepted: bool) -> Result<Option<Record>, CutoffError> {
    let malformed = || {
        if accepted {
            Err(error(INVALID))
        } else {
            Ok(None)
        }
    };
    if !header(raw, replica) {
        return malformed();
    }
    if canonical::observation_base64(raw["author"].as_str().unwrap(), Some(32)).is_err()
        || canonical::observation_base64(raw["sig"].as_str().unwrap(), None).is_err()
    {
        return malformed();
    }
    let check = |value| match portability(value, 64) {
        Ok(value) => Ok(Some(value)),
        Err(UNSUPPORTED) => Ok(None),
        Err(_) => {
            if accepted {
                Err(error(INVALID))
            } else {
                Ok(None)
            }
        }
    };
    let Some(body) = check(&raw["body"])? else {
        return Ok(None);
    };
    let Some(cap) = check(&raw["cap"])? else {
        return Ok(None);
    };
    let portable = body && cap;
    let inspected = match frame::inspect_value(raw) {
        Ok(frame) => frame,
        Err(_) => return malformed(),
    };
    if inspected.authentic() != accepted {
        return Err(error(INVALID));
    }
    if !portable
        || !["command", "authority", "inbox", "tombstone"].contains(&inspected.kind.as_str())
        || !push_fits(raw)
    {
        return Ok(None);
    }
    Ok(Some(Record {
        id: inspected.id,
        payload: inspected.payload,
        signature: inspected.signature,
    }))
}

fn known_atom(name: &str) -> bool {
    static SET: LazyLock<BTreeSet<&str>> = LazyLock::new(|| ATOMS.split_whitespace().collect());
    SET.contains(name)
}

fn closed(raw: &Value, keys: &[&str]) -> bool {
    raw.as_object()
        .is_some_and(|m| m.len() == keys.len() && keys.iter().all(|key| m.contains_key(*key)))
}
fn header(raw: &Value, replica: &str) -> bool {
    closed(
        raw,
        &[
            "v", "id", "replica", "author", "deps", "kind", "body", "cap", "sig",
        ],
    ) && raw["v"].as_u64() == Some(1)
        && raw["replica"].as_str() == Some(replica)
        && ["id", "author", "sig", "kind"]
            .iter()
            .all(|key| raw[*key].is_string())
        && raw["deps"]
            .as_array()
            .is_some_and(|deps| deps.iter().all(Value::is_string))
}

fn portability(raw: &Value, depth: usize) -> Result<bool, &'static str> {
    let tagged = raw.as_array().ok_or(INVALID)?;
    let tag = tagged.first().and_then(Value::as_str).ok_or(INVALID)?;
    if tag == "nil" && tagged.len() == 1 {
        return Ok(true);
    }
    if tagged.len() != 2 {
        return Err(INVALID);
    }
    let item = &tagged[1];
    match tag {
        "bool" if item.is_boolean() => Ok(true),
        "int" => canonical::portable_integer(item).map_err(|_| INVALID),
        "bin" => canonical::observation_base64(item.as_str().ok_or(INVALID)?, None)
            .map(|_| true)
            .map_err(|_| INVALID),
        "atom" => Ok(known_atom(item.as_str().ok_or(INVALID)?)),
        "delegation" => delegation_portability(item),
        "list" | "tuple" | "mapset" | "map" => {
            let entries = item.as_array().ok_or(INVALID)?;
            if depth == 0 {
                return Err(UNSUPPORTED);
            }
            let mut portable = true;
            for entry in entries {
                if tag == "map" {
                    let pair = entry
                        .as_array()
                        .filter(|pair| pair.len() == 2)
                        .ok_or(INVALID)?;
                    let key = portability(&pair[0], depth - 1)?;
                    let value = portability(&pair[1], depth - 1)?;
                    portable = key && value && portable;
                } else {
                    portable = portability(entry, depth - 1)? && portable;
                }
            }
            Ok(portable)
        }
        _ => Err(INVALID),
    }
}

fn delegation_portability(raw: &Value) -> Result<bool, &'static str> {
    const KEYS: [&str; 9] = [
        "id",
        "replica",
        "issuer",
        "audience",
        "parent_id",
        "ops",
        "roles",
        "live",
        "sig",
    ];
    let fields = raw.as_object().ok_or(UNSUPPORTED)?;
    if !KEYS.iter().all(|key| fields.contains_key(*key))
        || fields
            .keys()
            .any(|key| !KEYS.contains(&key.as_str()) && key != "expires_epoch")
        || !raw["id"].is_string()
        || !raw["replica"].is_string()
        || !(raw["parent_id"].is_null() || raw["parent_id"].is_string())
        || !raw["live"].is_boolean()
    {
        return Err(UNSUPPORTED);
    }
    for (key, size) in [("issuer", 32), ("audience", 32), ("sig", 64)] {
        canonical::observation_base64(raw[key].as_str().ok_or(UNSUPPORTED)?, Some(size))
            .map_err(|_| UNSUPPORTED)?;
    }
    if fields
        .get("expires_epoch")
        .is_some_and(|v| !v.as_u64().is_some_and(|n| n <= MAX_SAFE))
    {
        return Err(UNSUPPORTED);
    }
    let mut portable = true;
    for key in ["ops", "roles"] {
        for name in raw[key].as_array().ok_or(UNSUPPORTED)? {
            let name = name.as_str().ok_or(UNSUPPORTED)?;
            portable = known_atom(name) && portable;
        }
    }
    Ok(portable)
}

fn record(op: Record, rejected: bool) -> Term {
    let mut fields = vec![
        (Term::Atom("id".into()), Term::Binary(op.id.into_bytes())),
        (Term::Atom("bytes".into()), Term::Binary(op.payload)),
        (Term::Atom("sig".into()), Term::Binary(op.signature)),
    ];
    if rejected {
        fields.push((
            Term::Atom("reason".into()),
            Term::Atom("bad_signature".into()),
        ));
    }
    Term::Map(fields)
}
struct CountWriter {
    remaining: usize,
}
impl Write for CountWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(io::Error::other("push_limit"));
        }
        self.remaining -= bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn push_fits(raw: &Value) -> bool {
    let overhead = br#"{"type":"push","ops":["#.len() + b"]}".len();
    serde_json::to_writer(
        CountWriter {
            remaining: 64_000 - overhead,
        },
        raw,
    )
    .is_ok()
}
