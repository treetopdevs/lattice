//! Bounded local persistence. Retained signatures are verified by the TS consumer;
//! this boundary enforces identity, monotonic storage and immutable acknowledged frames.
use crate::key_store::KEY_ALIAS;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::{Signer as _, SigningKey};
use fs2::FileExt as _;
use lattice_mobile_core::{
    CarrierKeySeedStore, NativeCarrierSigner, ProductDatabase, ProductManifest,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    fs::{File, OpenOptions},
    path::Path,
    sync::Arc,
};
pub const HISTORY_KEY: &str = "treehouse:preview:history";
pub const HISTORY_BYTES: usize = 1_048_576;
pub const DRAFT_BYTES: usize = 16_384;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    product: String,
    revision: u64,
    public_key: Option<String>,
    profiles: Vec<Profile>,
    active: Option<String>,
    intent: Option<Intent>,
    cleared_drafts: BTreeMap<String, u64>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    product: String,
    replica: String,
    frames: Vec<Value>,
    outbox: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    kind: String,
    name: String,
    nonce: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Draft {
    pub version: u32,
    pub revision: u64,
    pub text: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub record: Option<String>,
    pub public_key: Option<String>,
    pub key_status: String,
}
fn empty() -> Record {
    Record {
        version: 1,
        product: "treehouse".into(),
        revision: 0,
        public_key: None,
        profiles: vec![],
        active: None,
        intent: None,
        cleared_drafts: BTreeMap::new(),
    }
}
fn token(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn replica(value: &str, kind: &str) -> bool {
    value
        .strip_prefix(&format!("replica:treehouse:{kind}:"))
        .and_then(|tail| tail.split_once("#root:"))
        .is_some_and(|(nonce, root)| token(nonce) && token(root))
}
fn parse(raw: Option<&str>) -> Result<Record, String> {
    let Some(raw) = raw else { return Ok(empty()) };
    if raw.len() > HISTORY_BYTES {
        return Err("preview_storage_limit".into());
    }
    let mut value: Value =
        serde_json::from_str(raw).map_err(|_| "invalid_preview_record".to_string())?;
    if value["version"] == 0 {
        let preceding = [
            "version",
            "product",
            "revision",
            "publicKey",
            "profiles",
            "active",
            "intent",
        ];
        let map = value.as_object_mut().ok_or("invalid_preview_record")?;
        if map.len() != preceding.len() || !preceding.iter().all(|key| map.contains_key(*key)) {
            return Err("invalid_preview_record".into());
        }
        map.insert("version".into(), Value::from(1));
        map.insert("clearedDrafts".into(), Value::Object(Default::default()));
    }
    let r: Record =
        serde_json::from_value(value).map_err(|_| "invalid_preview_record".to_string())?;
    let mut names = HashSet::new();
    if r.version != 1
        || r.product != "treehouse"
        || r.revision > MAX_REVISION
        || r.profiles.len() > 13
        || r.cleared_drafts.values().any(|v| *v > MAX_REVISION)
    {
        return Err("invalid_preview_record".into());
    }
    if let Some(key) = &r.public_key {
        let bytes = BASE64
            .decode(key)
            .map_err(|_| "invalid_public_identity".to_string())?;
        if bytes.len() != 32 || BASE64.encode(bytes) != *key {
            return Err("invalid_public_identity".into());
        }
    }
    if let Some(i) = &r.intent {
        if !matches!(i.kind.as_str(), "space" | "thread")
            || i.name.trim().is_empty()
            || i.name.len() > DRAFT_BYTES
            || !token(&i.nonce)
        {
            return Err("invalid_creation_intent".into());
        }
    }
    for p in &r.profiles {
        let kind = match p.product.as_str() {
            "Treehouse.Space" => "space",
            "Treehouse.Thread" => "thread",
            _ => return Err("invalid_local_profile".into()),
        };
        if !replica(&p.replica, kind) || !names.insert(p.replica.clone()) || p.frames.is_empty() {
            return Err("invalid_local_profile".into());
        }
        let mut ids = HashSet::new();
        for f in &p.frames {
            let map = f.as_object().ok_or("invalid_retained_frame")?;
            let required = [
                "v", "id", "replica", "author", "deps", "kind", "body", "cap", "sig",
            ];
            let id = f["id"].as_str().ok_or("invalid_retained_frame")?;
            if map.len() != required.len()
                || !required.iter().all(|k| map.contains_key(*k))
                || !token(id)
                || f["v"] != 1
                || f["replica"] != p.replica
                || !ids.insert(id.to_string())
                || !f["deps"]
                    .as_array()
                    .is_some_and(|deps| deps.iter().all(|d| d.as_str().is_some_and(token)))
            {
                return Err("invalid_retained_frame".into());
            }
        }
        if p.frames.iter().any(|f| {
            f["deps"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| !ids.contains(d.as_str().unwrap()))
        }) || p.outbox.iter().collect::<HashSet<_>>().len() != p.outbox.len()
            || p.outbox.iter().any(|id| !ids.contains(id))
        {
            return Err("incomplete_retained_history".into());
        }
    }
    if r.profiles
        .iter()
        .filter(|p| p.product == "Treehouse.Space")
        .count()
        != usize::from(!r.profiles.is_empty())
        || (r.public_key.is_none() && !r.profiles.is_empty())
        || r.active.as_ref().is_some_and(|a| !names.contains(a))
        || r.cleared_drafts.keys().any(|a| !names.contains(a))
    {
        return Err("invalid_preview_record".into());
    }
    Ok(r)
}
fn storage_error(_: impl std::fmt::Display) -> String {
    "local_store_unavailable".into()
}
pub struct PreviewStore {
    db: ProductDatabase,
    keys: Arc<dyn CarrierKeySeedStore>,
    identity_lock: File,
}
impl PreviewStore {
    /// The native app supplies its platform data directory; it is never an IPC argument.
    /// Tests supply an isolated directory and seed-store implementation through this seam.
    pub fn at_directory(
        directory: &Path,
        keys: Arc<dyn CarrierKeySeedStore>,
    ) -> Result<Self, String> {
        std::fs::create_dir_all(directory).map_err(storage_error)?;
        let manifest = ProductManifest::for_product("treehouse").map_err(storage_error)?;
        let db = ProductDatabase::open_path("treehouse", &directory.join(manifest.database_file))
            .map_err(storage_error)?;
        let identity_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("treehouse-identity.lock"))
            .map_err(storage_error)?;
        Ok(Self {
            db,
            keys,
            identity_lock,
        })
    }
    fn captured(&self) -> Result<(Option<String>, Record), String> {
        let raw = self.db.kv_get(HISTORY_KEY).map_err(storage_error)?;
        let record = parse(raw.as_deref())?;
        Ok((raw, record))
    }
    fn loaded_key(&self) -> Result<Option<SigningKey>, String> {
        self.keys
            .load_seed(KEY_ALIAS)
            .map(|seed| seed.map(|bytes| SigningKey::from_bytes(&bytes)))
            .map_err(|_| "key_store_unavailable".into())
    }
    pub fn open(&self) -> Result<OpenResult, String> {
        let (raw, r) = self.captured()?;
        let key = self
            .loaded_key()?
            .map(|k| BASE64.encode(k.verifying_key().as_bytes()));
        let status = match (&r.public_key, &key) {
            (Some(expected), Some(actual)) if expected != actual => "mismatch",
            (_, Some(_)) => "available",
            (Some(_), None) => "missing",
            (None, None) => "absent",
        };
        if r.public_key.is_none() && r.intent.is_none() && key.is_some() {
            return Err("missing_local_history".into());
        }
        Ok(OpenResult {
            record: raw,
            public_key: key,
            key_status: status.into(),
        })
    }
    pub fn initialize(&mut self) -> Result<String, String> {
        self.identity_lock.lock_exclusive().map_err(storage_error)?;
        let result = (|| {
            let (_, r) = self.captured()?;
            if r.public_key.is_some()
                || !r.profiles.is_empty()
                || !r.intent.is_some_and(|i| i.kind == "space")
            {
                return Err("identity_creation_not_allowed".into());
            }
            NativeCarrierSigner::new(self.keys.clone())
                .ensure_key(KEY_ALIAS)
                .map_err(|_| "key_store_unavailable".into())
        })();
        self.identity_lock.unlock().map_err(storage_error)?;
        result
    }
    pub fn sign(&self, bytes: &str) -> Result<String, String> {
        if bytes.len() > 85_336 {
            return Err("signing_limit".into());
        }
        let bytes = BASE64
            .decode(bytes)
            .map_err(|_| "invalid_signing_bytes".to_string())?;
        if bytes.is_empty() || bytes.len() > 64_000 {
            return Err("signing_limit".into());
        }
        let (_, r) = self.captured()?;
        let key = self.loaded_key()?.ok_or("identity_unavailable")?;
        if r.public_key.as_deref() != Some(BASE64.encode(key.verifying_key().as_bytes()).as_str()) {
            return Err("identity_mismatch".into());
        }
        Ok(BASE64.encode(key.sign(&bytes).to_bytes()))
    }
    pub fn commit(&mut self, expected_revision: u64, next: &str) -> Result<bool, String> {
        let (raw, old) = self.captured()?;
        if expected_revision != old.revision {
            return Ok(false);
        }
        let next_record = parse(Some(next))?;
        if serde_json::from_str::<Value>(next).map_err(|_| "invalid_preview_record")?["version"]
            != 1
        {
            return Err("invalid_preview_record".into());
        }
        if expected_revision >= MAX_REVISION || next_record.revision != expected_revision + 1 {
            return Err("invalid_revision".into());
        }
        if let Some(expected) = &next_record.public_key {
            let key = self.loaded_key()?.ok_or("identity_unavailable")?;
            if BASE64.encode(key.verifying_key().as_bytes()) != *expected {
                return Err("identity_mismatch".into());
            }
        }
        if old.public_key.is_some() && old.public_key != next_record.public_key {
            return Err("identity_mismatch".into());
        }
        if old.public_key.is_none()
            && next_record.public_key.is_some()
            && (!old.profiles.is_empty() || !old.intent.as_ref().is_some_and(|i| i.kind == "space"))
        {
            return Err("identity_creation_not_allowed".into());
        }
        if old.public_key.is_none() && old.intent.is_none() && self.loaded_key()?.is_some() {
            return Err("missing_local_history".into());
        }
        for previous in &old.profiles {
            let retained = next_record
                .profiles
                .iter()
                .find(|p| p.replica == previous.replica)
                .ok_or("retained_history_changed")?;
            if retained.product != previous.product
                || previous
                    .outbox
                    .iter()
                    .any(|id| !retained.outbox.contains(id))
                || previous
                    .frames
                    .iter()
                    .any(|frame| !retained.frames.iter().any(|candidate| candidate == frame))
            {
                return Err("retained_history_changed".into());
            }
        }
        if let (Some(previous), Some(pending)) = (&old.intent, &next_record.intent) {
            if previous.kind != pending.kind
                || previous.nonce != pending.nonce
                || previous.name != pending.name
            {
                return Err("creation_intent_changed".into());
            }
        }
        if let Some(pending) = &old.intent {
            if next_record.intent.is_none()
                && !next_record.profiles.iter().any(|p| {
                    p.replica.starts_with(&format!(
                        "replica:treehouse:{}:{}#root:",
                        pending.kind, pending.nonce
                    )) && !old.profiles.iter().any(|old| old.replica == p.replica)
                })
            {
                return Err("creation_incomplete".into());
            }
        }
        for (replica, revision) in &old.cleared_drafts {
            if next_record
                .cleared_drafts
                .get(replica)
                .is_none_or(|next| next < revision)
            {
                return Err("draft_watermark_changed".into());
            }
        }
        for (replica, revision) in &next_record.cleared_drafts {
            if old.cleared_drafts.get(replica) != Some(revision) {
                let current = self.load_draft(replica)?.ok_or("draft_unavailable")?;
                let old_count = old
                    .profiles
                    .iter()
                    .find(|p| p.replica == *replica)
                    .map_or(0, |p| p.frames.len());
                let new_count = next_record
                    .profiles
                    .iter()
                    .find(|p| p.replica == *replica)
                    .map_or(0, |p| p.frames.len());
                if *revision > current.revision || new_count <= old_count {
                    return Err("invalid_draft_watermark".into());
                }
            }
        }
        self.db
            .kv_compare_and_set(HISTORY_KEY, raw.as_deref(), next)
            .map_err(storage_error)
    }
    fn draft_key(&self, replica: &str) -> Result<String, String> {
        let (_, r) = self.captured()?;
        if !r
            .profiles
            .iter()
            .any(|p| p.product == "Treehouse.Thread" && p.replica == replica)
        {
            return Err("thread_unavailable".into());
        }
        Ok(format!("treehouse:preview:draft:{replica}"))
    }
    fn parse_draft(raw: Option<&str>) -> Result<Option<Draft>, String> {
        let Some(raw) = raw else { return Ok(None) };
        if raw.len() > 6 * DRAFT_BYTES + 128 {
            return Err("invalid_draft".into());
        }
        let draft: Draft = serde_json::from_str(raw).map_err(|_| "invalid_draft".to_string())?;
        if draft.version != 1 || draft.revision > MAX_REVISION || draft.text.len() > DRAFT_BYTES {
            return Err("invalid_draft".into());
        }
        Ok(Some(draft))
    }
    pub fn load_draft(&self, replica: &str) -> Result<Option<Draft>, String> {
        let raw = self
            .db
            .kv_get(&self.draft_key(replica)?)
            .map_err(storage_error)?;
        Self::parse_draft(raw.as_deref())
    }
    pub fn save_draft(
        &mut self,
        replica: &str,
        expected_revision: u64,
        text: &str,
    ) -> Result<Option<Draft>, String> {
        if text.len() > DRAFT_BYTES || expected_revision >= MAX_REVISION {
            return Err("draft_too_large".into());
        }
        let key = self.draft_key(replica)?;
        let raw = self.db.kv_get(&key).map_err(storage_error)?;
        if Self::parse_draft(raw.as_deref())?.map_or(0, |d| d.revision) != expected_revision {
            return Ok(None);
        }
        let draft = Draft {
            version: 1,
            revision: expected_revision + 1,
            text: text.into(),
        };
        let next = serde_json::to_string(&draft).map_err(storage_error)?;
        if self
            .db
            .kv_compare_and_set(&key, raw.as_deref(), &next)
            .map_err(storage_error)?
        {
            Ok(Some(draft))
        } else {
            Ok(None)
        }
    }
}
