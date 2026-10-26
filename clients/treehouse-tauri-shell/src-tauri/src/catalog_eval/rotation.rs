//! Closed catalog-rotation records and detached signatures. No parent/head,
//! cutoff completeness, history authority, retained trust or route judgment.
use super::{
    canonical::{encode, Result, Term},
    evidence_terms::*,
    frame,
};
const DOMAIN: &str = "lattice-treehouse-catalog-rotation-v1";
const INVALID: &str = "catalog_envelope_invalid";

pub struct Rotation<'a> {
    term: &'a Term,
    pub(super) space: &'a str,
    pub(super) bootstrap: &'a str,
    pub(super) parent: &'a str,
    pub(super) prior_catalog: &'a str,
    pub(super) generation: u64,
    pub(super) new_catalog_key: &'a [u8],
    pub(super) inventory_digest: &'a str,
    pub(super) cutoffs: Vec<Cutoff<'a>>,
}
pub struct Cutoff<'a> {
    pub(super) replica: &'a str,
    pub(super) frontier: Vec<&'a str>,
    pub(super) log_digest: &'a str,
}
impl<'a> Rotation<'a> {
    pub fn decode(term: &'a Term) -> Option<Self> {
        let m = closed(
            term,
            &[
                "version",
                "product",
                "space",
                "bootstrap",
                "parent",
                "prior_catalog",
                "generation",
                "new_catalog_key",
                "nonce",
                "inventory_digest",
                "cutoffs",
            ],
        )?;
        let space = text(m["space"])?;
        let generation = integer(m["generation"])?;
        if integer(m["version"]) != Some(1)
            || atom(m["product"]) != Some("treehouse")
            || space.is_empty()
            || !(1..=HORIZON).contains(&generation)
            || ![
                "bootstrap",
                "parent",
                "prior_catalog",
                "nonce",
                "inventory_digest",
            ]
            .iter()
            .all(|name| id(m[name]))
        {
            return None;
        }
        let values = list(m["cutoffs"])?;
        if !(1..=13).contains(&values.len()) {
            return None;
        }
        let mut cutoffs = Vec::with_capacity(values.len());
        for value in values {
            let m = closed(value, &["replica", "frontier", "log_digest"])?;
            let replica = text(m["replica"])?;
            if replica.is_empty() || !sorted_ids(m["frontier"]) || !id(m["log_digest"]) {
                return None;
            }
            cutoffs.push(Cutoff {
                replica,
                frontier: list(m["frontier"])?
                    .iter()
                    .map(text)
                    .collect::<Option<_>>()?,
                log_digest: text(m["log_digest"])?,
            });
        }
        if !cutoffs
            .windows(2)
            .all(|pair| pair[0].replica < pair[1].replica)
        {
            return None;
        }
        Some(Self {
            term,
            space,
            bootstrap: text(m["bootstrap"])?,
            parent: text(m["parent"])?,
            prior_catalog: text(m["prior_catalog"])?,
            generation,
            new_catalog_key: key(m["new_catalog_key"])?,
            inventory_digest: text(m["inventory_digest"])?,
            cutoffs,
        })
    }
    pub fn term(&self) -> &'a Term {
        self.term
    }
    pub fn signing_bytes(&self) -> Option<Vec<u8>> {
        domain(DOMAIN, self.term)
    }
    pub fn possession_bytes(&self) -> Option<Vec<u8>> {
        encode(&Term::List(vec![
            bin("lattice-treehouse-transport-possession-v1"),
            Term::Atom("catalog".into()),
            self.term.clone(),
        ]))
        .ok()
    }
}
pub struct Envelope<'a> {
    term: &'a Term,
    pub rotation: Rotation<'a>,
    pub(super) old_signature: &'a [u8],
    pub(super) new_signature: &'a [u8],
}
impl<'a> Envelope<'a> {
    pub fn decode(term: &'a Term) -> Option<Self> {
        let fields = closed(term, &["rotation", "old_signature", "new_signature"])?;
        Some(Self {
            term,
            rotation: Rotation::decode(fields["rotation"])?,
            old_signature: binary(fields["old_signature"]).filter(|s| s.len() == 64)?,
            new_signature: binary(fields["new_signature"]).filter(|s| s.len() == 64)?,
        })
    }
    /// The binding id commits the complete envelope, including both signatures.
    pub fn id(&self) -> Option<String> {
        digest(DOMAIN, self.term)
    }
    pub fn verify(&self, expected_old_key: &[u8]) -> bool {
        expected_old_key != self.rotation.new_catalog_key
            && self.rotation.signing_bytes().is_some_and(|bytes| {
                frame::verify_signature(expected_old_key, &bytes, self.old_signature).is_ok()
            })
            && self.rotation.possession_bytes().is_some_and(|bytes| {
                frame::verify_signature(self.rotation.new_catalog_key, &bytes, self.new_signature)
                    .is_ok()
            })
    }
}
#[derive(Debug)]
pub struct AuthenticRotation {
    id: String,
    envelope: Term,
}
impl AuthenticRotation {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn envelope(&self) -> &Term {
        &self.envelope
    }
}
/// Artifact-sized JSON only. A verified envelope supplies no graph transition.
pub fn verify(bytes: &[u8], expected_old_key: &[u8]) -> Result<AuthenticRotation> {
    let value = super::json::parse(bytes)?;
    let envelope = Term::from_carrier(&value)?;
    let decoded = Envelope::decode(&envelope).ok_or(INVALID)?;
    if !decoded.verify(expected_old_key) {
        return Err(INVALID);
    }
    Ok(AuthenticRotation {
        id: decoded.id().ok_or(INVALID)?,
        envelope,
    })
}
