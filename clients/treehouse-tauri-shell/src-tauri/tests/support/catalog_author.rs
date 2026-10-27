//! Fresh native operation/delegation authoring for reciprocal evaluation tests.
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use treehouse_tauri_shell::catalog_eval::canonical::{encode, Term};
pub fn text(value: &str) -> Value {
    json!(["bin", STANDARD.encode(value)])
}
pub fn signed(
    key: &SigningKey,
    replica: &str,
    deps: &[String],
    kind: &str,
    body: Value,
    cap: Value,
) -> Value {
    let fields = vec![
        Term::Binary(b"lattice-op-v2".to_vec()),
        Term::Binary(replica.as_bytes().to_vec()),
        Term::Binary(key.verifying_key().to_bytes().to_vec()),
        Term::List(
            deps.iter()
                .map(|id| Term::Binary(id.as_bytes().to_vec()))
                .collect(),
        ),
        Term::Atom(kind.into()),
        Term::from_carrier(&body).unwrap(),
        Term::from_carrier(&cap).unwrap(),
    ];
    let mut payload = vec![0x87];
    for field in fields {
        payload.extend(encode(&field).unwrap());
    }
    json!({"v":1,"id":URL_SAFE_NO_PAD.encode(Sha256::digest(&payload)),"replica":replica,
        "author":STANDARD.encode(key.verifying_key().to_bytes()),"deps":deps,"kind":kind,
        "body":body,"cap":cap,"sig":STANDARD.encode(key.sign(&payload).to_bytes())})
}
pub fn delegation(
    key: &SigningKey,
    replica: &str,
    audience: &[u8; 32],
    parent: Option<&str>,
    ops: &[&str],
    live: bool,
    roles: &[&str],
) -> Value {
    let public = key.verifying_key().to_bytes();
    let bytes = encode(&Term::List(vec![
        Term::Binary(b"lattice-delegation-v2".to_vec()),
        Term::Binary(replica.as_bytes().to_vec()),
        Term::Binary(public.to_vec()),
        Term::Binary(audience.to_vec()),
        parent.map_or(Term::Nil, |id| Term::Binary(id.as_bytes().to_vec())),
        Term::List(ops.iter().map(|s| Term::Atom((*s).into())).collect()),
        Term::List(
            roles
                .iter()
                .map(|role| Term::Atom((*role).into()))
                .collect(),
        ),
        Term::Bool(live),
    ]))
    .unwrap();
    json!(["delegation",{"id":URL_SAFE_NO_PAD.encode(Sha256::digest(&bytes)),"replica":replica,
        "issuer":STANDARD.encode(public),"audience":STANDARD.encode(audience),"parent_id":parent,
        "ops":ops,"roles":roles,"live":live,"sig":STANDARD.encode(key.sign(&bytes).to_bytes())}])
}
