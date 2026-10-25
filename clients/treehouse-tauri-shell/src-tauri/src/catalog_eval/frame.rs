//! Signature/hash authenticity only. A verified frame may still be unauthorized,
//! quarantined, causally incomplete or outside the catalog's replica scope.
use super::canonical::{base64, encode_observation, encode_op, observation_base64, Result, Term};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

pub const MAX_FRAME_BYTES: usize = 64_000;
const INVALID: &str = "catalog_envelope_invalid";

#[derive(Debug)]
pub struct AuthenticFrame {
    id: String,
    replica: String,
    payload: Vec<u8>,
    author: Vec<u8>,
    deps: Vec<String>,
    supplied_deps: Vec<String>,
    kind: String,
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
    pub fn author(&self) -> &[u8] {
        &self.author
    }
    pub fn deps(&self) -> &[String] {
        &self.deps
    }
    // Signatures bind the normalized set, not list order or multiplicity.
    // Existing continuation judges nevertheless compare sorted supplied deps;
    // retain that header evidence separately without changing DAG closure.
    pub(crate) fn supplied_deps(&self) -> &[String] {
        &self.supplied_deps
    }
    pub fn kind(&self) -> &str {
        &self.kind
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
    let inspected = inspect_value_inner(&value, false)?;
    if !inspected.authentic() {
        return Err(INVALID);
    }
    Ok(AuthenticFrame {
        id: inspected.id,
        replica: inspected.replica,
        payload: inspected.payload,
        author: inspected.author,
        deps: inspected.deps,
        supplied_deps: value["deps"]
            .as_array()
            .expect("inspected deps array")
            .iter()
            .map(|id| id.as_str().expect("inspected dependency text").to_owned())
            .collect(),
        kind: inspected.kind,
        body: inspected.body,
        cap: inspected.cap,
    })
}

// Unverified contents are deliberately a distinct crate-private type. Retained
// structural rejection evidence must never become an AuthenticFrame.
pub(crate) struct InspectedFrame {
    pub id: String,
    pub replica: String,
    pub payload: Vec<u8>,
    pub author: Vec<u8>,
    pub deps: Vec<String>,
    pub kind: String,
    pub body: Term,
    pub cap: Term,
    pub signature: Vec<u8>,
}
impl InspectedFrame {
    pub fn authentic(&self) -> bool {
        URL_SAFE_NO_PAD.encode(Sha256::digest(&self.payload)) == self.id
            && verify_signature(&self.author, &self.payload, &self.signature).is_ok()
    }
}

pub(crate) fn inspect_value(value: &serde_json::Value) -> Result<InspectedFrame> {
    inspect_value_inner(value, true)
}

fn inspect_value_inner(value: &serde_json::Value, observation: bool) -> Result<InspectedFrame> {
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
        value[key]
            .as_str()
            .filter(|s| observation || !s.is_empty())
            .ok_or(INVALID)
    };
    let id = text("id")?;
    let replica = text("replica")?;
    let author = base64(text("author")?, Some(32))?;
    let signature = if observation {
        observation_base64(text("sig")?, None)?
    } else {
        base64(text("sig")?, Some(64))?
    };
    let kind = text("kind")?;
    if !observation && !["command", "authority", "inbox", "tombstone"].contains(&kind) {
        return Err(INVALID);
    }
    let mut deps = value["deps"]
        .as_array()
        .ok_or(INVALID)?
        .iter()
        .map(|v| v.as_str().ok_or(INVALID))
        .collect::<Result<Vec<_>>>()?;
    for dep in &deps {
        if !observation {
            identifier(dep)?;
        }
    }
    deps.sort_unstable();
    deps.dedup();
    let term = |value: &serde_json::Value| {
        if observation {
            Term::from_observation(value)
        } else {
            Term::from_carrier(value)
        }
    };
    let body = term(&value["body"])?;
    let cap = term(&value["cap"])?;
    let payload_term = Term::List(vec![
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
    ]);
    let payload = if observation {
        encode_observation(&payload_term)?
    } else {
        encode_op(&payload_term)?
    };
    Ok(InspectedFrame {
        id: id.to_owned(),
        replica: replica.to_owned(),
        payload,
        author,
        deps: deps.into_iter().map(str::to_owned).collect(),
        kind: kind.to_owned(),
        body,
        cap,
        signature,
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
    let key =
        VerifyingKey::from_bytes(key.try_into().map_err(|_| INVALID)?).map_err(|_| INVALID)?;
    let signature = Signature::from_slice(signature).map_err(|_| INVALID)?;
    key.verify_strict(bytes, &signature).map_err(|_| INVALID)
}
