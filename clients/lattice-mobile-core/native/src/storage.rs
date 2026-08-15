//! Native, transactional per-product SQLite storage.
//!
//! Contract (plan 158 "Product isolation contract"):
//! - one database file per product, named by the product manifest;
//! - a migration ledger and a product marker inside the database;
//! - fail closed if the product marker does not match the opening app, a
//!   migration was interrupted, or a future schema is opened;
//! - the legacy JSON key-value state imports exactly once; private seeds
//!   never enter the database.
//!
//! Migration protocol: for each pending schema step the runner first commits
//! a `pending` ledger row, then runs the migration body and the `applied`
//! ledger update inside one transaction. An interruption therefore rolls the
//! body back automatically while the committed `pending` row makes every
//! later open fail closed with `InterruptedMigration`.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags, TransactionBehavior};

use crate::product::ProductManifest;

/// The newest schema version this build understands.
pub const PRODUCT_DATABASE_SCHEMA_VERSION: u32 = 3;

const MIGRATIONS: &[(u32, &str, &str)] = &[
    (
        1,
        "initial-kv",
        "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    ),
    (
        2,
        "outbox-frames",
        "CREATE TABLE frames (
           queue TEXT NOT NULL,
           seq INTEGER NOT NULL,
           frame TEXT NOT NULL,
           PRIMARY KEY (queue, seq)
         );",
    ),
    (
        3,
        "invalid-kv-quarantine",
        "CREATE TABLE quarantined_kv (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           reason TEXT NOT NULL,
           quarantined_at_unix_ms INTEGER NOT NULL
         );",
    ),
];

/// Key names that must never enter the product database. Signing seeds stay
/// behind the platform key-store command boundary.
const SECRET_KEY_FRAGMENTS: &[&str] = &[
    "seed",
    "private",
    "secret",
    "mnemonic",
    "pkcs8",
    "signing_key",
    "signing-key",
    "signingkey",
];
/// Byte length of an unpadded base64url SHA-256 digest.
pub const SHA256_BASE64URL_ID_BYTES: usize = 43;

const LEGACY_IMPORT_META_KEY: &str = "legacy_json_import";
const PENDING_MIGRATION_GRACE: Duration = Duration::from_secs(2);
const PENDING_MIGRATION_RETRY: Duration = Duration::from_millis(10);

/// Fail-closed errors produced by product storage and recovery operations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProductDatabaseError {
    /// The database carries another product's marker (cross-product refusal).
    ProductMarkerMismatch { expected: String, found: String },
    /// The database was created by a newer build (future-schema refusal).
    FutureSchema { found: u32, supported: u32 },
    /// A migration started but never completed; refuse until recovered.
    InterruptedMigration { version: u32 },
    /// A populated file is not a marked product database; never adopt it.
    /// Object-free SQLite files are recoverable aborted-bootstrap state.
    NotAProductDatabase(String),
    /// A storage key identifies non-replayable secret-shaped material.
    NonReplayableStorageKey(String),
    /// A storage key is explicitly prefixed for another product.
    ProductKeyMismatch { expected: String, found: String },
    /// The database is temporarily locked by another process or connection.
    DatabaseBusy(String),
    /// The SQLite database image is corrupt.
    DatabaseCorrupt(String),
    /// A filesystem operation outside SQLite failed.
    Io(String),
    /// A SQLite failure without a more specific classification.
    Sql(String),
}

impl std::fmt::Display for ProductDatabaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProductDatabaseError::ProductMarkerMismatch { expected, found } => write!(
                f,
                "product database marker mismatch: expected {expected}, found {found}"
            ),
            ProductDatabaseError::FutureSchema { found, supported } => write!(
                f,
                "product database schema {found} is newer than supported {supported}"
            ),
            ProductDatabaseError::InterruptedMigration { version } => {
                write!(f, "product database migration {version} was interrupted")
            }
            ProductDatabaseError::NotAProductDatabase(detail) => {
                write!(f, "not a product database: {detail}")
            }
            ProductDatabaseError::NonReplayableStorageKey(key) => {
                write!(
                    f,
                    "storage key contains non-replayable secret material at {key}"
                )
            }
            ProductDatabaseError::ProductKeyMismatch { expected, found } => write!(
                f,
                "storage key product mismatch: expected {expected}, found {found}"
            ),
            ProductDatabaseError::DatabaseBusy(detail) => {
                write!(f, "product database is temporarily busy: {detail}")
            }
            ProductDatabaseError::DatabaseCorrupt(detail) => {
                write!(f, "product database is corrupt: {detail}")
            }
            ProductDatabaseError::Io(detail) => write!(f, "product database io error: {detail}"),
            ProductDatabaseError::Sql(detail) => write!(f, "product database sql error: {detail}"),
        }
    }
}

impl std::error::Error for ProductDatabaseError {}

/// One applied or pending entry in the product schema ledger.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MigrationLedgerEntry {
    /// Monotonic schema version.
    pub version: u32,
    /// Stable migration name.
    pub name: String,
    /// Ledger state, normally `applied`.
    pub state: String,
}

/// Invalid rows recovered from a pre-guard database during attachment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InvalidEntryRecovery {
    /// Secret-shaped rows removed from active state with SQLite
    /// `secure_delete`; rollback-journal and filesystem residue are not wiped.
    pub purged_secret_keys: Vec<String>,
    /// Cross-product rows are preserved outside the active key-value table.
    pub quarantined_cross_product_keys: Vec<String>,
}

/// Outcome of the one-time legacy JSON import.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LegacyJsonImport {
    /// The legacy file was imported during this call.
    Imported { entries: usize },
    /// Replayable rows imported while invalid pre-guard keys were recovered.
    Recovered {
        /// Number of replayable string-valued entries imported.
        entries: usize,
        /// Secret-shaped keys removed from the legacy source file.
        purged_secret_keys: Vec<String>,
        /// Secret-shaped keys retained because source cleanup failed.
        retained_secret_keys: Vec<String>,
        /// Cross-product keys moved outside active product state.
        quarantined_cross_product_keys: Vec<String>,
        /// Replayable keys skipped because their values were not strings.
        skipped_non_string_keys: Vec<String>,
        /// Source verification or cleanup failure that did not undo import.
        legacy_cleanup_error: Option<String>,
    },
    /// A previous open already decided (imported or none); nothing changed.
    AlreadyDecided,
    /// No legacy file existed; recorded so a later file cannot clobber.
    NoLegacyState,
}

/// Test-only fault injection for the migration runner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MigrationFault {
    None,
    /// Fail after the pending ledger row commits but before the migration
    /// body runs.
    FailBeforeApply(u32),
    /// Fail after the migration body ran, before it is marked applied — the
    /// body's transaction must roll back.
    FailAfterApply(u32),
}

/// An opened, marker-verified per-product SQLite database.
pub struct ProductDatabase {
    conn: Connection,
    product: String,
}

impl ProductDatabase {
    /// Open (or create) the product database for `product` at `path`,
    /// enforcing the fail-closed contract.
    pub fn open_path(product: &str, path: &Path) -> Result<Self, ProductDatabaseError> {
        Self::open_path_with_fault(product, path, MigrationFault::None)
    }

    /// `open_path` with test-only fault injection for the migration runner.
    pub fn open_path_with_fault(
        product: &str,
        path: &Path,
        fault: MigrationFault,
    ) -> Result<Self, ProductDatabaseError> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| ProductDatabaseError::Io(error.to_string()))?;
            }
        }

        let mut conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(classify_sqlite_error)?;

        conn.busy_timeout(Duration::from_millis(5_000))
            .map_err(classify_sqlite_error)?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(classify_sqlite_error)?;

        // Serialize the bootstrap/verify decision on the opened database.
        // A second first-open waits, then observes the marker created by the
        // winner instead of racing a duplicate marker insert.
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(classify_sqlite_error)?;
        let object_count: i64 = tx
            .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| row.get(0))
            .map_err(classify_sqlite_error)?;

        if object_count == 0 {
            Self::bootstrap(&tx, product)?;
        } else {
            Self::verify_existing(&tx, product)?;
        }
        tx.commit().map_err(classify_sqlite_error)?;

        Self::run_migrations(&mut conn, fault)?;

        Ok(Self {
            conn,
            product: product.to_string(),
        })
    }

    fn bootstrap(
        tx: &rusqlite::Transaction<'_>,
        product: &str,
    ) -> Result<(), ProductDatabaseError> {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS product_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS migration_ledger (
               version INTEGER PRIMARY KEY,
               name TEXT NOT NULL,
               state TEXT NOT NULL,
               applied_at_unix_ms INTEGER NOT NULL
             );",
        )
        .map_err(classify_sqlite_error)?;
        tx.execute(
            "INSERT INTO product_meta (key, value) VALUES ('product', ?1)",
            [product],
        )
        .map_err(classify_sqlite_error)?;
        Ok(())
    }

    fn verify_existing(conn: &Connection, product: &str) -> Result<(), ProductDatabaseError> {
        let has_meta: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('product_meta', 'migration_ledger')",
                [],
                |row| row.get(0),
            )
            .map_err(classify_sqlite_error)?;
        if has_meta != 2 {
            return Err(ProductDatabaseError::NotAProductDatabase(
                "missing product marker or migration ledger".to_string(),
            ));
        }

        let found: Option<String> = conn
            .query_row(
                "SELECT value FROM product_meta WHERE key = 'product'",
                [],
                |row| row.get(0),
            )
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(classify_sqlite_error(other)),
            })?;
        let found = found.ok_or_else(|| {
            ProductDatabaseError::NotAProductDatabase("missing product marker row".to_string())
        })?;
        if found != product {
            return Err(ProductDatabaseError::ProductMarkerMismatch {
                expected: product.to_string(),
                found,
            });
        }

        Ok(())
    }

    fn run_migrations(
        conn: &mut Connection,
        fault: MigrationFault,
    ) -> Result<(), ProductDatabaseError> {
        let mut pending_since: Option<(u32, Instant)> = None;
        loop {
            // Serialize the pending/applied decision with every other opener.
            let decision = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(classify_sqlite_error)?;
            if let Some(version) = Self::pending_migration(&decision)? {
                drop(decision);
                let first_seen = match pending_since {
                    Some((seen_version, first_seen)) if seen_version == version => first_seen,
                    _ => {
                        let first_seen = Instant::now();
                        pending_since = Some((version, first_seen));
                        first_seen
                    }
                };
                if first_seen.elapsed() >= PENDING_MIGRATION_GRACE {
                    return Err(ProductDatabaseError::InterruptedMigration { version });
                }
                std::thread::sleep(PENDING_MIGRATION_RETRY);
                continue;
            }
            pending_since = None;

            let applied = Self::max_applied_version(&decision)?;
            if applied > PRODUCT_DATABASE_SCHEMA_VERSION {
                return Err(ProductDatabaseError::FutureSchema {
                    found: applied,
                    supported: PRODUCT_DATABASE_SCHEMA_VERSION,
                });
            }
            let Some((version, name, body)) =
                MIGRATIONS.iter().find(|(version, _, _)| *version > applied)
            else {
                decision.commit().map_err(classify_sqlite_error)?;
                return Ok(());
            };

            // Commit the pending marker first: an interruption anywhere in
            // the body leaves this row behind and later opens fail closed.
            decision
                .execute(
                    "INSERT INTO migration_ledger (version, name, state, applied_at_unix_ms)
                   VALUES (?1, ?2, 'pending', ?3)",
                    rusqlite::params![version, name, now_unix_ms()],
                )
                .map_err(classify_sqlite_error)?;
            decision.commit().map_err(classify_sqlite_error)?;

            if fault == MigrationFault::FailBeforeApply(*version) {
                return Err(ProductDatabaseError::InterruptedMigration { version: *version });
            }

            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(classify_sqlite_error)?;
            tx.execute_batch(body).map_err(classify_sqlite_error)?;

            if fault == MigrationFault::FailAfterApply(*version) {
                drop(tx); // rolls the body back; the pending row stays committed
                return Err(ProductDatabaseError::InterruptedMigration { version: *version });
            }

            tx.execute(
                "UPDATE migration_ledger SET state = 'applied', applied_at_unix_ms = ?2 WHERE version = ?1",
                rusqlite::params![version, now_unix_ms()],
            )
            .map_err(classify_sqlite_error)?;
            tx.commit().map_err(classify_sqlite_error)?;
        }
    }

    fn pending_migration(conn: &Connection) -> Result<Option<u32>, ProductDatabaseError> {
        conn.query_row(
            "SELECT version FROM migration_ledger WHERE state <> 'applied' ORDER BY version LIMIT 1",
            [],
            |row| row.get::<_, u32>(0),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(classify_sqlite_error(other)),
        })
    }

    fn max_applied_version(conn: &Connection) -> Result<u32, ProductDatabaseError> {
        conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM migration_ledger WHERE state = 'applied'",
            [],
            |row| row.get::<_, u32>(0),
        )
        .map_err(classify_sqlite_error)
    }

    /// Product name bound by the database marker at open time.
    pub fn product(&self) -> &str {
        &self.product
    }

    /// Highest applied migration version.
    pub fn schema_version(&self) -> Result<u32, ProductDatabaseError> {
        Self::max_applied_version(&self.conn)
    }

    /// Ordered migration ledger for diagnostics and acceptance tests.
    pub fn migration_ledger(&self) -> Result<Vec<MigrationLedgerEntry>, ProductDatabaseError> {
        let mut statement = self
            .conn
            .prepare("SELECT version, name, state FROM migration_ledger ORDER BY version")
            .map_err(classify_sqlite_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(MigrationLedgerEntry {
                    version: row.get(0)?,
                    name: row.get(1)?,
                    state: row.get(2)?,
                })
            })
            .map_err(classify_sqlite_error)?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(classify_sqlite_error)?);
        }
        Ok(entries)
    }

    /// Read one raw active-table value without key-policy validation.
    /// This diagnostic probe can confirm a refused write or recovery result;
    /// normal consumers should enumerate through [`Self::kv_entries`] after
    /// [`Self::recover_invalid_entries`].
    pub fn kv_get(&self, key: &str) -> Result<Option<String>, ProductDatabaseError> {
        self.conn
            .query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(classify_sqlite_error(other)),
            })
    }

    /// Persist one replayable value after secret and product-key validation.
    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), ProductDatabaseError> {
        validate_replayable_storage_key(&self.product, key)?;
        self.conn
            .execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key, value],
            )
            .map(|_| ())
            .map_err(classify_sqlite_error)
    }

    /// Atomically persist replayable key-value state after preflighting every
    /// key against the secret-material boundary.
    pub fn kv_set_batch(
        &mut self,
        entries: &HashMap<String, String>,
    ) -> Result<(), ProductDatabaseError> {
        for key in entries.keys() {
            validate_replayable_storage_key(&self.product, key)?;
        }
        if entries.is_empty() {
            return Ok(());
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(classify_sqlite_error)?;
        for (key, value) in entries {
            tx.execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key, value],
            )
            .map_err(classify_sqlite_error)?;
        }
        tx.commit().map_err(classify_sqlite_error)
    }

    /// Enumerate active replayable values. One contaminated row refuses the
    /// whole enumeration; call [`Self::recover_invalid_entries`] first when
    /// opening state written by a pre-guard build.
    pub fn kv_entries(&self) -> Result<HashMap<String, String>, ProductDatabaseError> {
        let mut statement = self
            .conn
            .prepare("SELECT key, value FROM kv")
            .map_err(classify_sqlite_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(classify_sqlite_error)?;
        let mut entries = HashMap::new();
        for row in rows {
            let (key, value) = row.map_err(classify_sqlite_error)?;
            validate_replayable_storage_key(&self.product, &key)?;
            entries.insert(key, value);
        }
        Ok(entries)
    }

    /// Recover invalid rows left by a pre-guard build. Secret-shaped rows are
    /// deleted without loading their values into Rust memory. Cross-product
    /// rows are moved transactionally to `quarantined_kv` for diagnosis and
    /// excluded from active Township state.
    pub fn recover_invalid_entries(
        &mut self,
    ) -> Result<InvalidEntryRecovery, ProductDatabaseError> {
        self.conn
            .execute_batch("PRAGMA secure_delete = ON;")
            .map_err(classify_sqlite_error)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(classify_sqlite_error)?;
        let (secret_keys, cross_product_keys) = {
            let mut statement = tx
                .prepare("SELECT key FROM kv")
                .map_err(classify_sqlite_error)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(classify_sqlite_error)?;
            let mut secret_keys = Vec::new();
            let mut cross_product_keys = Vec::new();
            for row in rows {
                let key = row.map_err(classify_sqlite_error)?;
                match validate_replayable_storage_key(&self.product, &key) {
                    Ok(()) => {}
                    Err(ProductDatabaseError::NonReplayableStorageKey(_)) => secret_keys.push(key),
                    Err(ProductDatabaseError::ProductKeyMismatch { .. }) => {
                        cross_product_keys.push(key)
                    }
                    Err(other) => return Err(other),
                }
            }
            (secret_keys, cross_product_keys)
        };

        for key in &secret_keys {
            tx.execute("DELETE FROM kv WHERE key = ?1", [key])
                .map_err(classify_sqlite_error)?;
        }
        for key in &cross_product_keys {
            tx.execute(
                "INSERT INTO quarantined_kv (key, value, reason, quarantined_at_unix_ms)
                   SELECT key, value, 'cross-product-key', ?2 FROM kv WHERE key = ?1
                   ON CONFLICT(key) DO UPDATE SET
                     value = excluded.value,
                     reason = excluded.reason,
                     quarantined_at_unix_ms = excluded.quarantined_at_unix_ms",
                rusqlite::params![key, now_unix_ms()],
            )
            .map_err(classify_sqlite_error)?;
            tx.execute("DELETE FROM kv WHERE key = ?1", [key])
                .map_err(classify_sqlite_error)?;
        }
        tx.commit().map_err(classify_sqlite_error)?;
        Ok(InvalidEntryRecovery {
            purged_secret_keys: secret_keys,
            quarantined_cross_product_keys: cross_product_keys,
        })
    }

    /// Read one cross-product value preserved for recovery diagnostics.
    pub fn quarantined_kv_get(&self, key: &str) -> Result<Option<String>, ProductDatabaseError> {
        self.conn
            .query_row(
                "SELECT value FROM quarantined_kv WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(classify_sqlite_error(other)),
            })
    }

    /// Import the shell's legacy JSON key-value state exactly once.
    ///
    /// The first call decides: either the legacy file's entries land in `kv`
    /// (`Imported`) or its absence is recorded (`NoLegacyState`). Every later
    /// call never re-imports state: it returns `AlreadyDecided` when the file
    /// is clean, or `Recovered` after retrying secret-residue cleanup. Secret-
    /// shaped keys are excluded and reported, cross-product keys are
    /// quarantined, string-valued replayable keys import, and the decision is
    /// committed. First-open recovery rewrites `legacy_path` without secret-
    /// shaped or cross-product keys while preserving every other entry,
    /// including non-string values skipped by import. Decided recovery strips
    /// secret-shaped keys while preserving other unimported values. Failed
    /// cleanup is reported rather than failing an already-committed import.
    pub fn import_legacy_json_values(
        &mut self,
        legacy_path: &Path,
    ) -> Result<LegacyJsonImport, ProductDatabaseError> {
        if Self::legacy_import_decided(&self.conn)? {
            return Ok(
                recover_decided_legacy_secret_residue(legacy_path, &self.product)
                    .unwrap_or(LegacyJsonImport::AlreadyDecided),
            );
        }

        let raw = match std::fs::read_to_string(legacy_path) {
            Ok(raw) => Some(raw),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(ProductDatabaseError::Io(error.to_string())),
        };

        let Some(raw) = raw else {
            let tx = self
                .conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(classify_sqlite_error)?;
            if Self::legacy_import_decided(&tx)? {
                drop(tx);
                return Ok(
                    recover_decided_legacy_secret_residue(legacy_path, &self.product)
                        .unwrap_or(LegacyJsonImport::AlreadyDecided),
                );
            }
            tx.execute(
                "INSERT INTO product_meta (key, value) VALUES (?1, 'none')",
                [LEGACY_IMPORT_META_KEY],
            )
            .map_err(classify_sqlite_error)?;
            tx.commit().map_err(classify_sqlite_error)?;
            return Ok(LegacyJsonImport::NoLegacyState);
        };

        let values = match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(serde_json::Value::Object(values)) => values,
            Ok(_) => {
                return Err(ProductDatabaseError::NotAProductDatabase(
                    "legacy JSON state must be an object".to_string(),
                ));
            }
            Err(error) => {
                return Err(ProductDatabaseError::NotAProductDatabase(format!(
                    "legacy JSON state decode failed: {error}"
                )));
            }
        };
        let mut replayable = Vec::new();
        let mut secret_keys = Vec::new();
        let mut cross_product = Vec::new();
        let mut skipped_non_string_keys = Vec::new();
        for (key, value) in &values {
            match validate_replayable_storage_key(&self.product, key) {
                Ok(()) => match value.as_str() {
                    Some(value) => replayable.push((key.clone(), value.to_string())),
                    None => skipped_non_string_keys.push(key.clone()),
                },
                Err(ProductDatabaseError::NonReplayableStorageKey(_)) => {
                    secret_keys.push(key.clone())
                }
                Err(ProductDatabaseError::ProductKeyMismatch { .. }) => {
                    let value = value.as_str().map(str::to_string).unwrap_or_else(|| {
                        serde_json::to_string(value)
                            .expect("a parsed JSON value must serialize back to JSON")
                    });
                    cross_product.push((key.clone(), value));
                }
                Err(other) => return Err(other),
            }
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(classify_sqlite_error)?;
        if Self::legacy_import_decided(&tx)? {
            drop(tx);
            return Ok(
                recover_decided_legacy_secret_residue(legacy_path, &self.product)
                    .unwrap_or(LegacyJsonImport::AlreadyDecided),
            );
        }
        for (key, value) in &replayable {
            tx.execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key.as_str(), value.as_str()],
            )
            .map_err(classify_sqlite_error)?;
        }
        for (key, value) in &cross_product {
            tx.execute(
                "INSERT INTO quarantined_kv (key, value, reason, quarantined_at_unix_ms)
                   VALUES (?1, ?2, 'legacy-cross-product-key', ?3)
                   ON CONFLICT(key) DO UPDATE SET
                     value = excluded.value,
                     reason = excluded.reason,
                     quarantined_at_unix_ms = excluded.quarantined_at_unix_ms",
                rusqlite::params![key.as_str(), value.as_str(), now_unix_ms()],
            )
            .map_err(classify_sqlite_error)?;
        }
        tx.execute(
            "INSERT INTO product_meta (key, value) VALUES (?1, 'imported')",
            [LEGACY_IMPORT_META_KEY],
        )
        .map_err(classify_sqlite_error)?;
        tx.commit().map_err(classify_sqlite_error)?;

        if secret_keys.is_empty() && cross_product.is_empty() && skipped_non_string_keys.is_empty()
        {
            Ok(LegacyJsonImport::Imported {
                entries: replayable.len(),
            })
        } else {
            let mut sanitized_values = values.clone();
            sanitized_values.retain(|key, _| {
                !secret_keys.contains(key)
                    && !cross_product
                        .iter()
                        .any(|(cross_product_key, _)| cross_product_key == key)
            });
            let legacy_cleanup_succeeded =
                rewrite_legacy_values_best_effort(legacy_path, &sanitized_values);
            Ok(LegacyJsonImport::Recovered {
                entries: replayable.len(),
                purged_secret_keys: if legacy_cleanup_succeeded {
                    secret_keys.clone()
                } else {
                    Vec::new()
                },
                retained_secret_keys: if legacy_cleanup_succeeded {
                    Vec::new()
                } else {
                    secret_keys
                },
                quarantined_cross_product_keys: cross_product
                    .into_iter()
                    .map(|(key, _)| key)
                    .collect(),
                skipped_non_string_keys,
                legacy_cleanup_error: if legacy_cleanup_succeeded {
                    None
                } else {
                    Some(format!(
                        "legacy JSON state recovery rewrite failed at {}",
                        legacy_path.display()
                    ))
                },
            })
        }
    }

    fn legacy_import_decided(conn: &Connection) -> Result<bool, ProductDatabaseError> {
        conn.query_row(
            "SELECT value FROM product_meta WHERE key = ?1",
            [LEGACY_IMPORT_META_KEY],
            |row| row.get::<_, String>(0),
        )
        .map(|_| true)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(classify_sqlite_error(other)),
        })
    }
}

fn recover_decided_legacy_secret_residue(
    legacy_path: &Path,
    product: &str,
) -> Option<LegacyJsonImport> {
    let raw = match std::fs::read_to_string(legacy_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            return Some(legacy_cleanup_error(format!(
                "legacy JSON state could not be verified at {}: {error}",
                legacy_path.display()
            )));
        }
    };
    let mut values = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Object(values)) => values,
        Ok(_) => {
            return Some(legacy_cleanup_error(format!(
                "legacy JSON state is not an object at {}",
                legacy_path.display()
            )));
        }
        Err(error) => {
            return Some(legacy_cleanup_error(format!(
                "legacy JSON state could not be decoded at {}: {error}",
                legacy_path.display()
            )));
        }
    };
    let secret_keys = values
        .keys()
        .filter(|key| {
            matches!(
                validate_replayable_storage_key(product, key),
                Err(ProductDatabaseError::NonReplayableStorageKey(_))
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    if secret_keys.is_empty() {
        return None;
    }
    values.retain(|key, _| !secret_keys.contains(key));
    let cleanup_succeeded = rewrite_legacy_values_best_effort(legacy_path, &values);
    Some(LegacyJsonImport::Recovered {
        entries: 0,
        purged_secret_keys: if cleanup_succeeded {
            secret_keys.clone()
        } else {
            Vec::new()
        },
        retained_secret_keys: if cleanup_succeeded {
            Vec::new()
        } else {
            secret_keys
        },
        quarantined_cross_product_keys: Vec::new(),
        skipped_non_string_keys: Vec::new(),
        legacy_cleanup_error: if cleanup_succeeded {
            None
        } else {
            Some(format!(
                "legacy JSON state recovery rewrite failed at {}",
                legacy_path.display()
            ))
        },
    })
}

fn legacy_cleanup_error(detail: String) -> LegacyJsonImport {
    LegacyJsonImport::Recovered {
        entries: 0,
        purged_secret_keys: Vec::new(),
        retained_secret_keys: Vec::new(),
        quarantined_cross_product_keys: Vec::new(),
        skipped_non_string_keys: Vec::new(),
        legacy_cleanup_error: Some(detail),
    }
}

fn rewrite_legacy_values_best_effort<T>(legacy_path: &Path, values: &T) -> bool
where
    T: serde::Serialize,
{
    let Ok(encoded) = serde_json::to_vec(values) else {
        return false;
    };
    let tmp_path = legacy_path.with_extension(format!(
        "recovery-{}-{}.tmp",
        std::process::id(),
        now_unix_ms()
    ));
    let result = (|| -> std::io::Result<()> {
        use std::io::Write;

        let mut file = std::fs::File::create(&tmp_path)?;
        file.write_all(&encoded)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp_path, legacy_path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    result.is_ok()
}

/// Refuse storage-field names that indicate non-replayable secret material.
/// Explicit cross-product prefixes refuse. Secret-shaped fragments refuse in
/// every segment, except an exact public `witness-artifact:v1:<sha256-id>`
/// content-hash segment.
pub fn validate_replayable_storage_key(
    product: &str,
    key: &str,
) -> Result<(), ProductDatabaseError> {
    let mut segments = key.split(':').collect::<Vec<_>>();
    while segments.last() == Some(&"") {
        segments.pop();
    }
    let contains_secret = segments.iter().enumerate().any(|(index, field)| {
        if public_artifact_id(&segments, index) {
            return false;
        }
        let lowered = field.to_lowercase();
        SECRET_KEY_FRAGMENTS
            .iter()
            .any(|fragment| lowered.contains(fragment))
    });
    if contains_secret {
        return Err(ProductDatabaseError::NonReplayableStorageKey(
            key.to_string(),
        ));
    }

    let expected_product = product.to_lowercase();
    let key_product = segments.first().map(|prefix| prefix.to_lowercase());
    if let Some(found) = key_product
        .as_deref()
        .filter(|prefix| ProductManifest::is_known_product(prefix) && *prefix != expected_product)
    {
        return Err(ProductDatabaseError::ProductKeyMismatch {
            expected: product.to_string(),
            found: found.to_string(),
        });
    }
    Ok(())
}

fn public_artifact_id(segments: &[&str], index: usize) -> bool {
    let Some(segment) = segments.get(index) else {
        return false;
    };
    index >= 2
        && index + 1 == segments.len()
        && segments[index - 2] == "witness-artifact"
        && segments[index - 1] == "v1"
        && segment.len() == SHA256_BASE64URL_ID_BYTES
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn classify_sqlite_error(error: rusqlite::Error) -> ProductDatabaseError {
    match &error {
        rusqlite::Error::SqliteFailure(details, _)
            if matches!(
                details.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            ProductDatabaseError::DatabaseBusy(error.to_string())
        }
        rusqlite::Error::SqliteFailure(details, _)
            if details.code == rusqlite::ErrorCode::NotADatabase =>
        {
            ProductDatabaseError::NotAProductDatabase(error.to_string())
        }
        rusqlite::Error::SqliteFailure(details, _)
            if details.code == rusqlite::ErrorCode::DatabaseCorrupt =>
        {
            ProductDatabaseError::DatabaseCorrupt(error.to_string())
        }
        _ => ProductDatabaseError::Sql(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_sqlite_error, ProductDatabaseError};

    #[test]
    fn open_probe_classifies_busy_and_locked_as_retryable() {
        for code in [rusqlite::ffi::SQLITE_BUSY, rusqlite::ffi::SQLITE_LOCKED] {
            let error = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), None);
            assert!(matches!(
                classify_sqlite_error(error),
                ProductDatabaseError::DatabaseBusy(_)
            ));
        }
    }

    #[test]
    fn open_probe_classifies_invalid_database_as_foreign() {
        let error = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOTADB),
            None,
        );
        assert!(matches!(
            classify_sqlite_error(error),
            ProductDatabaseError::NotAProductDatabase(_)
        ));
    }

    #[test]
    fn open_probe_classifies_corrupt_database_separately() {
        let error = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
            None,
        );
        assert!(matches!(
            classify_sqlite_error(error),
            ProductDatabaseError::DatabaseCorrupt(_)
        ));
    }

    #[test]
    fn open_probe_preserves_other_sql_failures() {
        let error = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_PERM),
            None,
        );
        assert!(matches!(
            classify_sqlite_error(error),
            ProductDatabaseError::Sql(_)
        ));
    }
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
