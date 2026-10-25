//! Signature/hash authenticity only. A verified frame may still be unauthorized,
//! quarantined, causally incomplete or outside the catalog's replica scope.
//! Atom vocabulary/admission belongs to the later portability stage, as in TS
//! `verifyCarrierOp`; unknown signed names are not signature failures.
use super::canonical::{base64, encode_op_payload, Result, Term};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};

pub const MAX_FRAME_BYTES: usize = 64_000;
const INVALID: &str = "catalog_envelope_invalid";

/// Signature/hash authenticity only, never wire admission or authority.
/// The product reader must enforce vocabulary/admission before any fold or trust decision.
#[derive(Debug)]
pub struct AuthenticFrame {
    id: String,
    replica: String,
    payload: Vec<u8>,
    body: Term,
    cap: Term,
}
impl AuthenticFrame {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn replica(&self) -> &str {
        &self.replica
    }
    pub fn payload(&self) -> &[u8] {
        &self.payload
    }
    pub fn body(&self) -> &Term {
        &self.body
    }
    pub fn cap(&self) -> &Term {
        &self.cap
    }
}

pub fn verify(bytes: &[u8]) -> Result<AuthenticFrame> {
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(INVALID);
    }
    let value = super::json::parse(bytes)?;
    let fields = value.as_object().ok_or(INVALID)?;
    const KEYS: [&str; 9] = [
        "v", "id", "replica", "author", "deps", "kind", "body", "cap", "sig",
    ];
    if fields.len() != KEYS.len()
        || KEYS.iter().any(|key| !fields.contains_key(*key))
        || value["v"].as_u64() != Some(1)
    {
        return Err(INVALID);
    }
    let text = |key: &str| -> Result<&str> {
        value[key].as_str().filter(|s| !s.is_empty()).ok_or(INVALID)
    };
    let id = text("id")?;
    let replica = text("replica")?;
    let author = base64(text("author")?, Some(32))?;
    let signature = base64(text("sig")?, Some(64))?;
    let kind = text("kind")?;
    if !["command", "authority", "inbox", "tombstone"].contains(&kind) {
        return Err(INVALID);
    }
    let mut deps = value["deps"]
        .as_array()
        .ok_or(INVALID)?
        .iter()
        .map(|v| v.as_str().ok_or(INVALID))
        .collect::<Result<Vec<_>>>()?;
    for dep in &deps {
        identifier(dep)?;
    }
    deps.sort_unstable();
    deps.dedup();
    let body = Term::from_carrier(&value["body"])?;
    let cap = Term::from_carrier(&value["cap"])?;
    let payload = encode_op_payload(&[
        Term::Binary(b"lattice-op-v2".to_vec()),
        Term::Binary(replica.as_bytes().to_vec()),
        Term::Binary(author.clone()),
        Term::List(
            deps.iter()
                .map(|id| Term::Binary(id.as_bytes().to_vec()))
                .collect(),
        ),
        Term::Atom(kind.to_owned()),
        body.clone(),
        cap.clone(),
    ])?;
    if URL_SAFE_NO_PAD.encode(Sha256::digest(&payload)) != id {
        return Err(INVALID);
    }
    verify_signature(&author, &payload, &signature)?;
    Ok(AuthenticFrame {
        id: id.to_owned(),
        replica: replica.to_owned(),
        payload,
        body,
        cap,
    })
}

pub(crate) fn identifier(value: &str) -> Result<()> {
    if value.len() != 43 {
        return Err(INVALID);
    }
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| INVALID)?;
    if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(bytes) != value {
        return Err(INVALID);
    }
    Ok(())
}

pub(crate) fn verify_signature(key: &[u8], bytes: &[u8], signature: &[u8]) -> Result<()> {
    crate::signature::verify(key, bytes, signature)
        .then_some(())
        .ok_or(INVALID)
}
