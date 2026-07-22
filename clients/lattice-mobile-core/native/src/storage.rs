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

use rusqlite::{Connection, OpenFlags, TransactionBehavior};

/// The newest schema version this build understands.
pub const PRODUCT_DATABASE_SCHEMA_VERSION: u32 = 2;

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
];

const LEGACY_IMPORT_META_KEY: &str = "legacy_json_import";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProductDatabaseError {
    /// The database carries another product's marker (cross-product refusal).
    ProductMarkerMismatch {
        expected: String,
        found: String,
    },
    /// The database was created by a newer build (future-schema refusal).
    FutureSchema {
        found: u32,
        supported: u32,
    },
    /// A migration started but never completed; refuse until recovered.
    InterruptedMigration {
        version: u32,
    },
    /// The file exists but is not a product database; never silently recreate.
    NotAProductDatabase(String),
    /// The legacy JSON import found secret-shaped material; refuse the import.
    LegacyImportContainsSecret(String),
    Io(String),
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
            ProductDatabaseError::LegacyImportContainsSecret(key) => {
                write!(f, "legacy JSON state contains secret material at {key}")
            }
            ProductDatabaseError::Io(detail) => write!(f, "product database io error: {detail}"),
            ProductDatabaseError::Sql(detail) => write!(f, "product database sql error: {detail}"),
        }
    }
}

impl std::error::Error for ProductDatabaseError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MigrationLedgerEntry {
    pub version: u32,
    pub name: String,
    pub state: String,
}

/// Outcome of the one-time legacy JSON import.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LegacyJsonImport {
    /// The legacy file was imported during this call.
    Imported { entries: usize },
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
        let existed = path.exists();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| ProductDatabaseError::Io(error.to_string()))?;
            }
        }

        let mut conn = if existed {
            let conn = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
            // Force a header read so a foreign file refuses before any write.
            conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| ProductDatabaseError::NotAProductDatabase(error.to_string()))?;
            conn
        } else {
            Connection::open(path).map_err(|error| ProductDatabaseError::Sql(error.to_string()))?
        };

        conn.busy_timeout(std::time::Duration::from_millis(5_000))
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;

        if existed {
            Self::verify_existing(&conn, product)?;
        } else {
            Self::bootstrap(&mut conn, product)?;
        }

        Self::run_migrations(&mut conn, fault)?;

        Ok(Self {
            conn,
            product: product.to_string(),
        })
    }

    fn bootstrap(conn: &mut Connection, product: &str) -> Result<(), ProductDatabaseError> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS product_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS migration_ledger (
               version INTEGER PRIMARY KEY,
               name TEXT NOT NULL,
               state TEXT NOT NULL,
               applied_at_unix_ms INTEGER NOT NULL
             );",
        )
        .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        tx.execute(
            "INSERT INTO product_meta (key, value) VALUES ('product', ?1)",
            [product],
        )
        .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        tx.commit()
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))
    }

    fn verify_existing(conn: &Connection, product: &str) -> Result<(), ProductDatabaseError> {
        let has_meta: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('product_meta', 'migration_ledger')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
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
                other => Err(ProductDatabaseError::Sql(other.to_string())),
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
        if let Some(version) = Self::pending_migration(conn)? {
            return Err(ProductDatabaseError::InterruptedMigration { version });
        }

        let applied = Self::max_applied_version(conn)?;
        if applied > PRODUCT_DATABASE_SCHEMA_VERSION {
            return Err(ProductDatabaseError::FutureSchema {
                found: applied,
                supported: PRODUCT_DATABASE_SCHEMA_VERSION,
            });
        }

        for (version, name, body) in MIGRATIONS {
            if *version <= applied {
                continue;
            }

            // Commit the pending marker first: an interruption anywhere in
            // the body leaves this row behind and later opens fail closed.
            conn.execute(
                "INSERT INTO migration_ledger (version, name, state, applied_at_unix_ms)
                   VALUES (?1, ?2, 'pending', ?3)",
                rusqlite::params![version, name, now_unix_ms()],
            )
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;

            if fault == MigrationFault::FailBeforeApply(*version) {
                return Err(ProductDatabaseError::InterruptedMigration { version: *version });
            }

            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
            tx.execute_batch(body)
                .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;

            if fault == MigrationFault::FailAfterApply(*version) {
                drop(tx); // rolls the body back; the pending row stays committed
                return Err(ProductDatabaseError::InterruptedMigration { version: *version });
            }

            tx.execute(
                "UPDATE migration_ledger SET state = 'applied', applied_at_unix_ms = ?2 WHERE version = ?1",
                rusqlite::params![version, now_unix_ms()],
            )
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
            tx.commit()
                .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        }

        Ok(())
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
            other => Err(ProductDatabaseError::Sql(other.to_string())),
        })
    }

    fn max_applied_version(conn: &Connection) -> Result<u32, ProductDatabaseError> {
        conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM migration_ledger WHERE state = 'applied'",
            [],
            |row| row.get::<_, u32>(0),
        )
        .map_err(|error| ProductDatabaseError::Sql(error.to_string()))
    }

    pub fn product(&self) -> &str {
        &self.product
    }

    pub fn schema_version(&self) -> Result<u32, ProductDatabaseError> {
        Self::max_applied_version(&self.conn)
    }

    pub fn migration_ledger(&self) -> Result<Vec<MigrationLedgerEntry>, ProductDatabaseError> {
        let mut statement = self
            .conn
            .prepare("SELECT version, name, state FROM migration_ledger ORDER BY version")
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        let rows = statement
            .query_map([], |row| {
                Ok(MigrationLedgerEntry {
                    version: row.get(0)?,
                    name: row.get(1)?,
                    state: row.get(2)?,
                })
            })
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|error| ProductDatabaseError::Sql(error.to_string()))?);
        }
        Ok(entries)
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<String>, ProductDatabaseError> {
        self.conn
            .query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(ProductDatabaseError::Sql(other.to_string())),
            })
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), ProductDatabaseError> {
        self.conn
            .execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key, value],
            )
            .map(|_| ())
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))
    }

    pub fn kv_entries(&self) -> Result<HashMap<String, String>, ProductDatabaseError> {
        let mut statement = self
            .conn
            .prepare("SELECT key, value FROM kv")
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        let mut entries = HashMap::new();
        for row in rows {
            let (key, value) = row.map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
            entries.insert(key, value);
        }
        Ok(entries)
    }

    /// Import the shell's legacy JSON key-value state exactly once.
    ///
    /// The first call decides: either the legacy file's entries land in `kv`
    /// (`Imported`) or its absence is recorded (`NoLegacyState`). Every later
    /// call — including after reopen — returns `AlreadyDecided` and never
    /// lets a late or tampered legacy file clobber migrated state. Secret
    /// shaped keys refuse the whole import and leave the decision open so a
    /// repaired file can import.
    pub fn import_legacy_json_values(
        &mut self,
        legacy_path: &Path,
    ) -> Result<LegacyJsonImport, ProductDatabaseError> {
        let decided: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM product_meta WHERE key = ?1",
                [LEGACY_IMPORT_META_KEY],
                |row| row.get(0),
            )
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(ProductDatabaseError::Sql(other.to_string())),
            })?;
        if decided.is_some() {
            return Ok(LegacyJsonImport::AlreadyDecided);
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
                .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
            tx.execute(
                "INSERT INTO product_meta (key, value) VALUES (?1, 'none')",
                [LEGACY_IMPORT_META_KEY],
            )
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
            tx.commit()
                .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
            return Ok(LegacyJsonImport::NoLegacyState);
        };

        let values: HashMap<String, String> = serde_json::from_str(&raw).map_err(|error| {
            ProductDatabaseError::NotAProductDatabase(format!(
                "legacy JSON state decode failed: {error}"
            ))
        })?;

        for key in values.keys() {
            if secret_shaped_key(key) {
                return Err(ProductDatabaseError::LegacyImportContainsSecret(
                    key.clone(),
                ));
            }
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        for (key, value) in &values {
            tx.execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key.as_str(), value.as_str()],
            )
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        }
        tx.execute(
            "INSERT INTO product_meta (key, value) VALUES (?1, 'imported')",
            [LEGACY_IMPORT_META_KEY],
        )
        .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        tx.commit()
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;

        Ok(LegacyJsonImport::Imported {
            entries: values.len(),
        })
    }
}

fn secret_shaped_key(key: &str) -> bool {
    let lowered = key.to_lowercase();
    SECRET_KEY_FRAGMENTS
        .iter()
        .any(|fragment| lowered.contains(fragment))
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
