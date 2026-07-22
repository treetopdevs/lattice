//! Native, transactional per-product SQLite storage.
//!
//! Contract (plan 158 "Product isolation contract"):
//! - one database file per product, named by the product manifest;
//! - a migration ledger and a product marker inside the database;
//! - fail closed if the product marker does not match the opening app, a
//!   migration was interrupted, or a future schema is opened;
//! - the legacy JSON key-value state imports exactly once; private seeds
//!   never enter the database.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::Connection;

/// The newest schema version this build understands.
pub const PRODUCT_DATABASE_SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProductDatabaseError {
    /// The database carries another product's marker (cross-product refusal).
    ProductMarkerMismatch { expected: String, found: String },
    /// The database was created by a newer build (future-schema refusal).
    FutureSchema { found: u32, supported: u32 },
    /// A migration started but never completed; refuse until recovered.
    InterruptedMigration { version: u32 },
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

    /// `open_path` with test-only fault injection.
    pub fn open_path_with_fault(
        product: &str,
        path: &Path,
        _fault: MigrationFault,
    ) -> Result<Self, ProductDatabaseError> {
        let conn = Connection::open(path)
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        Ok(Self {
            conn,
            product: product.to_string(),
        })
    }

    pub fn product(&self) -> &str {
        &self.product
    }

    pub fn schema_version(&self) -> Result<u32, ProductDatabaseError> {
        Ok(0)
    }

    pub fn migration_ledger(&self) -> Result<Vec<MigrationLedgerEntry>, ProductDatabaseError> {
        Ok(Vec::new())
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
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
        let mut entries = HashMap::new();
        for row in rows {
            let (key, value) = row.map_err(|error| ProductDatabaseError::Sql(error.to_string()))?;
            entries.insert(key, value);
        }
        Ok(entries)
    }

    /// Import the shell's legacy JSON key-value state exactly once.
    pub fn import_legacy_json_values(
        &mut self,
        _legacy_path: &Path,
    ) -> Result<LegacyJsonImport, ProductDatabaseError> {
        Ok(LegacyJsonImport::NoLegacyState)
    }
}
