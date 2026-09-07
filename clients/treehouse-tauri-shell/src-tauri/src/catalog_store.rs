//! Candidate persistence only. These bytes and counters are untrusted input to a
//! future native CatalogTrust evaluator, never installed trust or route authority.
//! The owner must obtain identity presence natively and serialize identity creation
//! with this call. This module neither queries custody nor proves that absence.
//! No evaluator provenance, bootstrap review, freshness of external history, or
//! semantic counter advancement is inferred from successfully storing a candidate.
use base64::{engine::general_purpose::STANDARD, Engine};
use lattice_mobile_core::ProductDatabase;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const CANDIDATE_KEY: &str = "treehouse:catalog:candidate:v1";
// Local persistence bound, not an artifact or evaluator acceptance bound.
const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = MAX_SNAPSHOT_BYTES.div_ceil(3) * 4 + 512;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct StoreToken {
    pub trust_revision: u64,
    pub history_generation: u64,
}
impl StoreToken {
    fn valid(self) -> bool {
        self.trust_revision < MAX_SAFE_INTEGER && self.history_generation < MAX_SAFE_INTEGER
    }
}

/// Native owner fact, not deserializable and never accepted from public IPC.
#[derive(Clone, Copy)]
pub(crate) enum NativeIdentityPresence {
    Absent,
    Present,
}

/// Owned read result. Its private raw expectation is used verbatim by SQLite CAS.
/// A record carries no authenticated/installed status and exposes no routes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CandidateCatalogRecord {
    raw: Option<String>,
    snapshot: Vec<u8>,
    token: StoreToken,
}
impl CandidateCatalogRecord {
    pub(crate) fn snapshot_bytes(&self) -> &[u8] {
        &self.snapshot
    }
    pub(crate) fn token(&self) -> StoreToken {
        self.token
    }
    pub(crate) fn is_missing(&self) -> bool {
        self.raw.is_none()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Record {
    version: u8,
    token: StoreToken,
    snapshot: String,
    content_digest: String,
}

pub(crate) fn load_candidate(
    db: &ProductDatabase,
    identity: NativeIdentityPresence,
) -> Result<CandidateCatalogRecord, &'static str> {
    let raw = db
        .kv_get(CANDIDATE_KEY)
        .map_err(|_| "trust_persistence_failed")?;
    match raw {
        Some(raw) => decode(raw),
        None if matches!(identity, NativeIdentityPresence::Present) => {
            Err("trust_recovery_required")
        }
        None => Ok(CandidateCatalogRecord {
            raw: None,
            snapshot: Vec::new(),
            token: StoreToken {
                trust_revision: 0,
                history_generation: 0,
            },
        }),
    }
}

/// Persist caller-supplied candidate metadata exactly. Both counters belong to the
/// future evaluator/owner contract: this primitive does not derive or advance them.
/// Even identical replay compares the whole current record atomically.
pub(crate) fn store_candidate(
    db: &mut ProductDatabase,
    expected: &CandidateCatalogRecord,
    identity: NativeIdentityPresence,
    token: StoreToken,
    snapshot: &[u8],
) -> Result<CandidateCatalogRecord, &'static str> {
    if expected.is_missing() && matches!(identity, NativeIdentityPresence::Present) {
        return Err("trust_recovery_required");
    }
    if !token.valid() || snapshot.is_empty() || snapshot.len() > MAX_SNAPSHOT_BYTES {
        return Err("malformed_catalog");
    }
    let record = Record {
        version: 1,
        token,
        snapshot: STANDARD.encode(snapshot),
        content_digest: STANDARD.encode(Sha256::digest(snapshot)),
    };
    let raw = serde_json::to_string(&record).map_err(|_| "trust_persistence_failed")?;
    if !db
        .kv_compare_and_set(CANDIDATE_KEY, expected.raw.as_deref(), &raw)
        .map_err(|_| "trust_persistence_failed")?
    {
        return Err("stale_trust_snapshot");
    }
    decode(raw)
}

fn decode(raw: String) -> Result<CandidateCatalogRecord, &'static str> {
    let refuse = "trust_recovery_required";
    if raw.len() > MAX_RECORD_BYTES {
        return Err(refuse);
    }
    let record: Record = serde_json::from_str(&raw).map_err(|_| refuse)?;
    if record.version != 1 || !record.token.valid() {
        return Err(refuse);
    }
    let snapshot = STANDARD.decode(&record.snapshot).map_err(|_| refuse)?;
    if snapshot.is_empty()
        || snapshot.len() > MAX_SNAPSHOT_BYTES
        || STANDARD.encode(&snapshot) != record.snapshot
        || STANDARD.encode(Sha256::digest(&snapshot)) != record.content_digest
    {
        return Err(refuse);
    }
    Ok(CandidateCatalogRecord {
        raw: Some(raw),
        snapshot,
        token: record.token,
    })
}
