//! Product-neutral native seams shared by the Lattice mobile shells.
//!
//! This crate owns the pieces of the Township Tauri shell that must not stay
//! product-specific once Toolshed and Treehouse shells exist:
//!
//! - the normative product isolation manifest (`product`), backed by the
//!   plan-158 table in `clients/lattice-mobile-core/products.json`;
//! - native, transactional per-product SQLite storage with a migration
//!   ledger and a product marker (`storage`);
//! - the one-time import of a shell's legacy JSON key-value state into that
//!   database (`storage::ProductDatabase::import_legacy_json_values`).
//!
//! Private signing seeds never enter this crate's database: they stay behind
//! the platform key-store command boundary owned by each shell.

pub mod discovery;
pub mod product;
pub mod signer;
pub mod storage;

pub use discovery::{
    collect_pairing_discovery_adverts, decode_pairing_discovery_packet,
    encode_pairing_discovery_packet, PairingDiscoveryAdvert, PAIRING_DISCOVERY_MAX_PACKET_BYTES,
};
pub use product::{ProductManifest, ProductManifestError};
pub use signer::{CarrierKeySeedStore, InMemoryCarrierKeySeedStore, NativeCarrierSigner};
pub use storage::{
    validate_replayable_storage_key, InvalidEntryRecovery, LegacyJsonImport, MigrationFault,
    MigrationLedgerEntry, ProductDatabase, ProductDatabaseError, PRODUCT_DATABASE_SCHEMA_VERSION,
    SHA256_BASE64URL_ID_BYTES,
};
