//! Closed catalog record/signature verification. This cannot select a trusted
//! bootstrap, judge references, resolve a fork or authorize an installed route.
use super::canonical::{base64, encode, Result, Term};
use super::frame::{identifier, verify_signature};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const INVALID: &str = "catalog_envelope_invalid";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const CATALOG_FIELDS: [&str; 8] = [
    "version",
    "product",
    "space",
    "bootstrap",
    "binding",
    "revision",
    "previous",
    "entries",
];
const ENTRY_FIELDS: [&str; 11] = [
    "product",
    "replica",
    "kind",
    "schema",
    "root",
    "genesis",
    "creation",
    "reference",
    "route",
    "service_id",
    "service_key",
];

#[derive(Debug)]
pub struct AuthenticCatalog {
    id: String,
    catalog: Term,
    signing_bytes: Vec<u8>,
}
impl AuthenticCatalog {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn catalog(&self) -> &Term {
        &self.catalog
    }
    pub fn signing_bytes(&self) -> &[u8] {
        &self.signing_bytes
    }
}

pub fn verify(bytes: &[u8], expected_catalog_key: &[u8]) -> Result<AuthenticCatalog> {
    let value = super::json::parse(bytes)?;
    let envelope = Term::from_carrier(&value)?;
    closed(&envelope, &["catalog", "signature"])?;
    let catalog = field(&envelope, "catalog")?;
    let signature = binary(field(&envelope, "signature")?, 64)?;
    let signing_bytes = signing_bytes(catalog)?;
    verify_signature(expected_catalog_key, &signing_bytes, signature)?;
    Ok(AuthenticCatalog {
        id: URL_SAFE_NO_PAD.encode(Sha256::digest(&signing_bytes)),
        catalog: catalog.clone(),
        signing_bytes,
    })
}

pub fn signing_bytes(catalog: &Term) -> Result<Vec<u8>> {
    validate(catalog)?;
    encode(&Term::List(vec![
        Term::Binary(b"lattice-treehouse-transport-catalog-v1".to_vec()),
        catalog.clone(),
    ]))
}

fn validate(catalog: &Term) -> Result<()> {
    closed(catalog, &CATALOG_FIELDS)?;
    literal(field(catalog, "version")?, &Term::Integer(1))?;
    literal(field(catalog, "product")?, &Term::Atom("treehouse".into()))?;
    let space = text(field(catalog, "space")?)?;
    let bootstrap = id(field(catalog, "bootstrap")?)?;
    id(field(catalog, "binding")?)?;
    let revision = match field(catalog, "revision")? {
        Term::Integer(n) if *n <= MAX_SAFE_INTEGER => *n,
        _ => return Err(INVALID),
    };
    let previous = field(catalog, "previous")?;
    if revision == 0 {
        literal(previous, &Term::Nil)?;
    } else {
        id(previous)?;
    }
    let entries = match field(catalog, "entries")? {
        Term::List(values) if (1..=13).contains(&values.len()) => values,
        _ => return Err(INVALID),
    };
    let mut last_replica = None;
    let mut routes = BTreeSet::new();
    let mut service = None;
    let mut spaces = 0;
    for entry in entries {
        closed(entry, &ENTRY_FIELDS)?;
        literal(field(entry, "product")?, &Term::Atom("treehouse".into()))?;
        let replica = text(field(entry, "replica")?)?;
        if last_replica.is_some_and(|prior| prior >= replica) {
            return Err(INVALID);
        }
        last_replica = Some(replica);
        let kind = match field(entry, "kind")? {
            Term::Atom(name) if name == "space" || name == "thread" => name,
            _ => return Err(INVALID),
        };
        literal(
            field(entry, "schema")?,
            &Term::Atom(format!("treehouse_{kind}_v1")),
        )?;
        binary(field(entry, "root")?, 32)?;
        for key in ["genesis", "creation", "reference"] {
            id(field(entry, key)?)?;
        }
        let route = text(field(entry, "route")?)?;
        identifier(route.strip_prefix("/r/").ok_or(INVALID)?)?;
        if !routes.insert(route) {
            return Err(INVALID);
        }
        let service_id = id(field(entry, "service_id")?)?;
        let service_key = binary(field(entry, "service_key")?, 32)?;
        let binding = (service_id, service_key);
        if service.is_some_and(|previous| previous != binding) {
            return Err(INVALID);
        }
        service = Some(binding);
        if kind == "space" {
            spaces += 1;
            if replica != space || id(field(entry, "reference")?)? != bootstrap {
                return Err(INVALID);
            }
        }
    }
    if spaces != 1 {
        return Err(INVALID);
    }
    Ok(())
}

fn closed(record: &Term, keys: &[&str]) -> Result<()> {
    match record {
        Term::Map(pairs)
            if pairs.len() == keys.len()
                && pairs.iter().all(
                    |(key, _)| matches!(key, Term::Atom(name) if keys.contains(&name.as_str())),
                ) =>
        {
            Ok(())
        }
        _ => Err(INVALID),
    }
}
fn field<'a>(record: &'a Term, key: &str) -> Result<&'a Term> {
    record.atom_field(key).ok_or(INVALID)
}
fn literal(value: &Term, expected: &Term) -> Result<()> {
    if value == expected {
        Ok(())
    } else {
        Err(INVALID)
    }
}
fn text(value: &Term) -> Result<&str> {
    match value {
        Term::Binary(bytes) if !bytes.is_empty() => std::str::from_utf8(bytes).map_err(|_| INVALID),
        _ => Err(INVALID),
    }
}
fn binary(value: &Term, length: usize) -> Result<&[u8]> {
    match value {
        Term::Binary(bytes) if bytes.len() == length => Ok(bytes),
        _ => Err(INVALID),
    }
}
fn id(value: &Term) -> Result<&str> {
    let value = text(value)?;
    identifier(value)?;
    Ok(value)
}

/// Adapter for the public fixture/command key spelling; the verifier itself
/// takes exact key bytes, never an embedded caller-selected signer field.
pub fn public_key(value: &str) -> Result<Vec<u8>> {
    base64(value, Some(32))
}
