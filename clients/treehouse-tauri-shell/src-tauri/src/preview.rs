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
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{File, OpenOptions},
    path::Path,
    sync::Arc,
};
pub const HISTORY_KEY: &str = "treehouse:preview:history";
pub const HISTORY_BYTES: usize = 1_048_576;
pub const DRAFT_BYTES: usize = 16_384;
/// One Space route plus at most three Thread routes.
const MAX_ROUTES: usize = 4;
/// The join intent carries no user text; this constant satisfies the non-empty name rule.
const JOIN_INTENT_NAME: &str = "join";
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
    relay: Option<Relay>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    product: String,
    replica: String,
    frames: Vec<Value>,
    /// Ids this device authored. Never shrinks.
    outbox: Vec<String>,
    /// Ids known durable on the relay. Grows only; a subset of the retained frame ids.
    acked: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Relay {
    local_realm: String,
    routes: Vec<Route>,
}
#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Route {
    replica: String,
    url: String,
    expected_peer_realm: String,
    expected_peer_pubkey: String,
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
        version: 2,
        product: "treehouse".into(),
        revision: 0,
        public_key: None,
        profiles: vec![],
        active: None,
        intent: None,
        cleared_drafts: BTreeMap::new(),
        relay: None,
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
fn public_key_text(value: &str) -> bool {
    BASE64
        .decode(value)
        .is_ok_and(|bytes| bytes.len() == 32 && BASE64.encode(bytes) == value)
}
/// A realm is pinned for good, so it must already be trimmed (treehouse_routes.ts `realmText`).
fn realm_text(value: &str) -> bool {
    !value.is_empty() && value.trim() == value && value.len() <= 256
}
fn token43(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
/// `replica:treehouse:{space|thread}:<43>#root:<43>`, as the shell's SPACE_REPLICA/THREAD_REPLICA.
fn route_replica(value: &str) -> bool {
    let Some(rest) = value
        .strip_prefix("replica:treehouse:space:")
        .or_else(|| value.strip_prefix("replica:treehouse:thread:"))
    else {
        return false;
    };
    rest.split_once("#root:")
        .is_some_and(|(nonce, root)| token43(nonce) && token43(root))
}
/// wss to any host, or ws to a loopback host only; no credentials and no fragment (`validRouteUrl`).
fn route_url(value: &str) -> bool {
    // Printable ASCII only, as the shell's `validRouteUrl` requires, so a persisted route always reloads.
    if value.len() > 2048
        || value.contains('#')
        || value.bytes().any(|b| !(0x21..=0x7e).contains(&b))
    {
        return false;
    }
    // The shell parses with WHATWG URL, which lowercases the scheme and host.
    let scheme_end = value.find("://").unwrap_or(0);
    let rest = &value[(scheme_end + 3).min(value.len())..];
    let secure = match value[..scheme_end].to_ascii_lowercase().as_str() {
        "wss" => true,
        "ws" => false,
        _ => return false,
    };
    let authority = rest.split(['/', '?']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    // Every host accepted here is one the shell's URL parser also accepts, so a persisted route can
    // always be reloaded; anything outside these forms is refused.
    let loopback = match authority.strip_prefix('[') {
        Some(v6) => match v6.split_once(']') {
            Some((inner, port)) if port.is_empty() || valid_port(port) => {
                // Only the canonical text WHATWG serializes to, so both sides accept the same hosts.
                match inner.parse::<std::net::Ipv6Addr>() {
                    Ok(address)
                        if !inner.contains('.')
                            && address.to_string() == inner.to_ascii_lowercase() =>
                    {
                        address.is_loopback()
                    }
                    _ => return false,
                }
            }
            _ => return false,
        },
        None => {
            let host = match authority.split_once(':') {
                Some((host, port)) if valid_port(&format!(":{port}")) => host,
                Some(_) => return false,
                None => authority,
            };
            match route_host(host) {
                Some(loopback) => loopback,
                None => return false,
            }
        }
    };
    secure || loopback
}
/// A name of ASCII letters, digits, `.`, `-` and `_`, or a dotted IPv4 address when the last label is
/// numeric (WHATWG parses such a host as IPv4). Returns whether it is the loopback name or address.
fn route_host(host: &str) -> Option<bool> {
    if host.is_empty()
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return None;
    }
    let last = host.trim_end_matches('.').rsplit('.').next().unwrap_or("");
    let numeric = !last.is_empty()
        && (last.bytes().all(|b| b.is_ascii_digit())
            || last.to_ascii_lowercase().starts_with("0x"));
    if numeric {
        return host
            .parse::<std::net::Ipv4Addr>()
            .ok()
            .map(|address| address == std::net::Ipv4Addr::LOCALHOST);
    }
    Some(host.eq_ignore_ascii_case("localhost"))
}
/// `:` followed by an optional port; WHATWG treats an empty port as the scheme default.
fn valid_port(suffix: &str) -> bool {
    suffix.strip_prefix(':').is_some_and(|port| {
        port.is_empty()
            || port.len() <= 5
                && port.bytes().all(|b| b.is_ascii_digit())
                && port.parse::<u32>().is_ok_and(|n| n <= 65_535)
    })
}
fn valid_relay(relay: &Relay) -> bool {
    let mut replicas = HashSet::new();
    realm_text(&relay.local_realm)
        && relay.routes.len() <= MAX_ROUTES
        // Exactly one Space route, so at most three Threads: a pinned set lacking its Space could never
        // be repaired, since saved routes are only ever extended.
        && relay
            .routes
            .iter()
            .filter(|r| r.replica.starts_with("replica:treehouse:space:"))
            .count()
            == 1
        && relay.routes.iter().all(|r| {
            route_replica(&r.replica)
                && route_url(&r.url)
                && realm_text(&r.expected_peer_realm)
                && public_key_text(&r.expected_peer_pubkey)
                && replicas.insert(r.replica.clone())
        })
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
    // Closed v1 envelope: migrates in memory only. Opening never writes; the next
    // explicit commit persists v2.
    if value["version"] == 1 {
        let v1 = [
            "version",
            "product",
            "revision",
            "publicKey",
            "profiles",
            "active",
            "intent",
            "clearedDrafts",
        ];
        let map = value.as_object_mut().ok_or("invalid_preview_record")?;
        if map.len() == v1.len() && v1.iter().all(|key| map.contains_key(*key)) {
            if let Some(profiles) = map.get_mut("profiles").and_then(Value::as_array_mut) {
                for profile in profiles {
                    if let Some(profile) = profile.as_object_mut() {
                        if profile.len() == 4 {
                            profile.insert("acked".into(), Value::Array(vec![]));
                        }
                    }
                }
            }
            map.insert("version".into(), Value::from(2));
            map.insert("relay".into(), Value::Null);
        }
    }
    // Option fields default to None when absent, but a v2 envelope names relay explicitly.
    if !value
        .as_object()
        .is_some_and(|map| map.contains_key("relay"))
    {
        return Err("invalid_preview_record".into());
    }
    let r: Record =
        serde_json::from_value(value).map_err(|_| "invalid_preview_record".to_string())?;
    let mut names = HashSet::new();
    if r.version != 2
        || r.product != "treehouse"
        || r.revision > MAX_REVISION
        || r.profiles.len() > 13
        || r.cleared_drafts.values().any(|v| *v > MAX_REVISION)
    {
        return Err("invalid_preview_record".into());
    }
    if r.public_key
        .as_deref()
        .is_some_and(|key| !public_key_text(key))
    {
        return Err("invalid_public_identity".into());
    }
    if r.relay.as_ref().is_some_and(|relay| !valid_relay(relay)) {
        return Err("invalid_relay".into());
    }
    if let Some(i) = &r.intent {
        if !matches!(i.kind.as_str(), "space" | "thread" | "join")
            || i.name.trim().is_empty()
            || i.name.len() > DRAFT_BYTES
            || (i.kind == "join" && i.name != JOIN_INTENT_NAME)
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
        if p.acked.iter().collect::<HashSet<_>>().len() != p.acked.len()
            || p.acked.iter().any(|id| !ids.contains(id))
        {
            return Err("invalid_local_profile".into());
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
    /// Plan 181 5b: one fixed test key for the dev-trace packaged variant. Absent from the
    /// ordinary build, where the key always comes from the platform key store.
    #[cfg(feature = "treehouse-dev-trace")]
    fixed_key: Option<SigningKey>,
    /// Command-name lines for the packaged harness. Never a payload.
    #[cfg(feature = "treehouse-dev-trace")]
    trace_file: Option<std::path::PathBuf>,
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
            #[cfg(feature = "treehouse-dev-trace")]
            fixed_key: None,
            #[cfg(feature = "treehouse-dev-trace")]
            trace_file: None,
        })
    }
    /// Dev-trace seam: a store whose identity is one fixed test key. Nothing is generated and
    /// nothing is written to a key store, so two instances in two directories never share a
    /// Keychain alias.
    #[cfg(feature = "treehouse-dev-trace")]
    pub fn at_directory_dev(directory: &Path, seed: [u8; 32]) -> Result<Self, String> {
        Self::at_directory_dev_with(
            directory,
            seed,
            Arc::new(lattice_mobile_core::InMemoryCarrierKeySeedStore::default()),
        )
    }
    /// As `at_directory_dev`, with the (never consulted) key store supplied so tests can prove it.
    #[cfg(feature = "treehouse-dev-trace")]
    pub fn at_directory_dev_with(
        directory: &Path,
        seed: [u8; 32],
        keys: Arc<dyn CarrierKeySeedStore>,
    ) -> Result<Self, String> {
        let mut store = Self::at_directory(directory, keys)?;
        store.fixed_key = Some(SigningKey::from_bytes(&seed));
        Ok(store)
    }
    #[cfg(feature = "treehouse-dev-trace")]
    pub fn with_dev_trace(mut self, file: std::path::PathBuf) -> Self {
        self.trace_file = Some(file);
        self
    }
    #[cfg(feature = "treehouse-dev-trace")]
    fn note(&self, command: &str) {
        use std::io::Write as _;
        if let Some(file) = &self.trace_file {
            if let Ok(mut out) = OpenOptions::new().create(true).append(true).open(file) {
                let _ = writeln!(out, "{command}");
            }
        }
    }
    fn captured(&self) -> Result<(Option<String>, Record), String> {
        let raw = self.db.kv_get(HISTORY_KEY).map_err(storage_error)?;
        let record = parse(raw.as_deref())?;
        Ok((raw, record))
    }
    fn loaded_key(&self) -> Result<Option<SigningKey>, String> {
        // The fixed key appears under the same condition `open` uses for `missing_local_history`:
        // only once the record holds a public key or an intent, so first launch reports absent.
        #[cfg(feature = "treehouse-dev-trace")]
        if let Some(fixed) = &self.fixed_key {
            let (_, r) = self.captured()?;
            return Ok((r.public_key.is_some() || r.intent.is_some()).then(|| fixed.clone()));
        }
        self.keys
            .load_seed(KEY_ALIAS)
            .map(|seed| seed.map(|bytes| SigningKey::from_bytes(&bytes)))
            .map_err(|_| "key_store_unavailable".into())
    }
    pub fn open(&self) -> Result<OpenResult, String> {
        #[cfg(feature = "treehouse-dev-trace")]
        self.note("treehouse_open");
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
        #[cfg(feature = "treehouse-dev-trace")]
        self.note("treehouse_initialize_identity");
        self.identity_lock.lock_exclusive().map_err(storage_error)?;
        let result = (|| {
            let (_, r) = self.captured()?;
            if r.public_key.is_some()
                || !r.profiles.is_empty()
                || !r
                    .intent
                    .is_some_and(|i| matches!(i.kind.as_str(), "space" | "join"))
            {
                return Err("identity_creation_not_allowed".into());
            }
            #[cfg(feature = "treehouse-dev-trace")]
            if let Some(fixed) = &self.fixed_key {
                return Ok(BASE64.encode(fixed.verifying_key().as_bytes()));
            }
            NativeCarrierSigner::new(self.keys.clone())
                .ensure_key(KEY_ALIAS)
                .map_err(|_| "key_store_unavailable".into())
        })();
        self.identity_lock.unlock().map_err(storage_error)?;
        result
    }
    pub fn sign(&self, bytes: &str) -> Result<String, String> {
        #[cfg(feature = "treehouse-dev-trace")]
        self.note("treehouse_sign_carrier");
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
        #[cfg(feature = "treehouse-dev-trace")]
        self.note("treehouse_commit");
        let (raw, old) = self.captured()?;
        if expected_revision != old.revision {
            return Ok(false);
        }
        let next_record = parse(Some(next))?;
        if serde_json::from_str::<Value>(next).map_err(|_| "invalid_preview_record")?["version"]
            != 2
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
            && (!old.profiles.is_empty()
                || !old
                    .intent
                    .as_ref()
                    .is_some_and(|i| matches!(i.kind.as_str(), "space" | "join")))
        {
            return Err("identity_creation_not_allowed".into());
        }
        // A join intent is only ever created on a record with no identity and no history.
        if old.intent.is_none()
            && next_record
                .intent
                .as_ref()
                .is_some_and(|i| i.kind == "join")
            && (old.public_key.is_some()
                || !old.profiles.is_empty()
                || next_record.public_key.is_some()
                || !next_record.profiles.is_empty())
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
                || previous.acked.iter().any(|id| !retained.acked.contains(id))
                || previous
                    .frames
                    .iter()
                    .any(|frame| !retained.frames.iter().any(|candidate| candidate == frame))
            {
                return Err("retained_history_changed".into());
            }
        }
        // A saved relay set is never replaced: the local realm and every saved route stay exactly as
        // they were, and only new routes may be added.
        if let Some(previous) = &old.relay {
            let kept = next_record.relay.as_ref().is_some_and(|next| {
                next.local_realm == previous.local_realm
                    && previous
                        .routes
                        .iter()
                        .all(|route| next.routes.contains(route))
            });
            if !kept {
                return Err("relay_already_configured".into());
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
        if old.intent.as_ref().is_some_and(|i| i.kind == "join") {
            // The join intent is spent by the commit that persists the key: the identity is
            // present, the intent is gone and no profile exists yet (the first dependency-closed
            // pulled batch arrives later). The replica strings are the founder's, so the
            // creation-nonce match used for Space and Thread intents cannot apply.
            let spent = next_record.intent.is_none();
            if (spent && (next_record.public_key.is_none() || !next_record.profiles.is_empty()))
                || (!spent && next_record.public_key.is_some())
            {
                return Err("creation_incomplete".into());
            }
        } else if let Some(pending) = &old.intent {
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
                let current = self.read_draft(replica)?.ok_or("draft_unavailable")?;
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
    fn captured_draft(&self, replica: &str) -> Result<(String, Option<String>), String> {
        let (_, r) = self.captured()?;
        if !r
            .profiles
            .iter()
            .any(|p| p.product == "Treehouse.Thread" && p.replica == replica)
        {
            return Err("thread_unavailable".into());
        }
        // Existing drafts retain their original CAS key and revision. New rows use
        // lowercase hex so random public replica tokens cannot trip the secret guard.
        let legacy_key = format!("treehouse:preview:draft:{replica}");
        let key = format!(
            "treehouse:preview:draft:{:x}",
            Sha256::digest(replica.as_bytes())
        );
        let legacy = self.db.kv_get(&legacy_key).map_err(storage_error)?;
        let current = self.db.kv_get(&key).map_err(storage_error)?;
        match (legacy, current) {
            (Some(_), Some(_)) => Err("draft_storage_conflict".into()),
            (Some(raw), None) => Ok((legacy_key, Some(raw))),
            (None, raw) => Ok((key, raw)),
        }
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
        #[cfg(feature = "treehouse-dev-trace")]
        self.note("treehouse_load_draft");
        self.read_draft(replica)
    }
    fn read_draft(&self, replica: &str) -> Result<Option<Draft>, String> {
        let (_, raw) = self.captured_draft(replica)?;
        Self::parse_draft(raw.as_deref())
    }
    pub fn save_draft(
        &mut self,
        replica: &str,
        expected_revision: u64,
        text: &str,
    ) -> Result<Option<Draft>, String> {
        #[cfg(feature = "treehouse-dev-trace")]
        self.note("treehouse_save_draft");
        if text.len() > DRAFT_BYTES || expected_revision >= MAX_REVISION {
            return Err("draft_too_large".into());
        }
        let (key, raw) = self.captured_draft(replica)?;
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
