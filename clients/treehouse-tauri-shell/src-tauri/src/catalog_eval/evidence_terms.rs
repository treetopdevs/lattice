//! Closed term helpers shared by the bounded authority evidence components.
use super::{
    canonical::{encode, Term},
    frame,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
pub(super) const HORIZON: u64 = 9_007_199_254_740_991;
pub(super) fn binary(t: &Term) -> Option<&[u8]> {
    if let Term::Binary(v) = t {
        Some(v)
    } else {
        None
    }
}
pub(super) fn text(t: &Term) -> Option<&str> {
    std::str::from_utf8(binary(t)?).ok()
}
pub(super) fn atom(t: &Term) -> Option<&str> {
    if let Term::Atom(v) = t {
        Some(v)
    } else {
        None
    }
}
pub(super) fn integer(t: &Term) -> Option<u64> {
    if let Term::Integer(v) = t {
        Some(*v)
    } else {
        None
    }
}
pub(super) fn list(t: &Term) -> Option<&[Term]> {
    if let Term::List(v) = t {
        Some(v)
    } else {
        None
    }
}
pub(super) fn field<'a>(t: &'a Term, name: &str) -> Option<&'a Term> {
    let Term::Map(v) = t else { return None };
    v.iter()
        .find(|(k, _)| atom(k) == Some(name))
        .map(|(_, v)| v)
}
pub(super) fn closed<'a>(t: &'a Term, keys: &[&str]) -> Option<BTreeMap<&'a str, &'a Term>> {
    let Term::Map(v) = t else { return None };
    if v.len() != keys.len() {
        return None;
    }
    let mut result = BTreeMap::new();
    for (k, v) in v {
        let k = atom(k)?;
        if !keys.contains(&k) || result.insert(k, v).is_some() {
            return None;
        }
    }
    Some(result)
}
pub(super) fn key(t: &Term) -> Option<&[u8]> {
    binary(t).filter(|k| k.len() == 32)
}
pub(super) fn id(t: &Term) -> bool {
    text(t).is_some_and(|s| {
        s.len() == 43
            && URL_SAFE_NO_PAD
                .decode(s)
                .is_ok_and(|b| b.len() == 32 && URL_SAFE_NO_PAD.encode(b) == s)
    })
}
pub(super) fn sorted_ids(t: &Term) -> bool {
    list(t).is_some_and(|v| v.iter().all(id) && v.windows(2).all(|p| binary(&p[0]) < binary(&p[1])))
}
pub(super) fn kind_role(kind: &Term, role: &Term) -> bool {
    matches!(
        (atom(kind), atom(role)),
        (Some("space"), Some("admin")) | (Some("thread"), Some("moderator"))
    )
}
pub(super) fn bin(s: &str) -> Term {
    Term::Binary(s.as_bytes().to_vec())
}
pub(super) fn map(fields: Vec<(&str, Term)>) -> Term {
    Term::Map(
        fields
            .into_iter()
            .map(|(k, v)| (Term::Atom(k.into()), v))
            .collect(),
    )
}
pub(super) fn domain(domain: &str, t: &Term) -> Option<Vec<u8>> {
    encode(&Term::List(vec![bin(domain), t.clone()])).ok()
}
pub(super) fn digest(domain_name: &str, t: &Term) -> Option<String> {
    Some(URL_SAFE_NO_PAD.encode(Sha256::digest(domain(domain_name, t)?)))
}
pub(super) fn witnesses(t: &Term) -> Option<Vec<Vec<u8>>> {
    let mut w: Vec<_> = list(t)?
        .iter()
        .map(|t| key(t).map(Vec::from))
        .collect::<Option<_>>()?;
    w.sort();
    if w.windows(2).any(|p| p[0] == p[1]) {
        return None;
    }
    Some(w)
}
pub(super) struct Certificate<'a> {
    pub claim: &'a Term,
    pub signatures: Vec<(&'a [u8], &'a [u8])>,
}
pub(super) fn certificate(t: &Term) -> Option<Certificate<'_>> {
    let c = closed(t, &["claim", "signatures"])?;
    let signatures = list(c["signatures"])?
        .iter()
        .map(|t| {
            let s = closed(t, &["witness", "signature"])?;
            Some((
                key(s["witness"])?,
                binary(s["signature"]).filter(|s| s.len() == 64)?,
            ))
        })
        .collect::<Option<_>>()?;
    Some(Certificate {
        claim: c["claim"],
        signatures,
    })
}
pub(super) fn verify(
    c: &Certificate<'_>,
    expected: &Term,
    witnesses: &[Vec<u8>],
    threshold: u64,
    tag: &str,
) -> bool {
    if (c.signatures.len() as u64) < threshold || !c.signatures.windows(2).all(|p| p[0].0 < p[1].0)
    {
        return false;
    }
    let Some(payload) = domain(tag, c.claim) else {
        return false;
    };
    if domain(tag, expected).as_deref() != Some(payload.as_slice()) {
        return false;
    }
    c.signatures.iter().all(|(w, s)| {
        witnesses.iter().any(|allowed| allowed.as_slice() == *w)
            && frame::verify_signature(w, &payload, s).is_ok()
    })
}
