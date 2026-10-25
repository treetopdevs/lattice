//! Closed member-continuity consent statements. Shape and detached signatures
//! prove no membership, authority, causal freshness or one-use ceremony.
use super::{
    canonical::{encode, Term},
    evidence_terms::*,
    frame,
};

const CLAIM_FIELDS: &[&str] = &[
    "version",
    "product",
    "space",
    "old_pub",
    "new_pub",
    "old_admission",
    "old_membership",
    "nonce",
    "deps",
    "epoch",
    "epoch_basis",
    "parents",
    "vouchers",
];

#[derive(Debug)]
pub struct Voucher<'a> {
    pub(super) member: &'a [u8],
    pub(super) admission: &'a str,
}

#[derive(Debug)]
pub struct Claim<'a> {
    pub(super) term: &'a Term,
    pub(super) space: &'a str,
    pub(super) old_pub: &'a [u8],
    pub(super) new_pub: &'a [u8],
    pub(super) old_admission: &'a str,
    pub(super) active: bool,
    pub(super) deps: Vec<&'a str>,
    pub(super) epoch: u64,
    pub(super) epoch_basis: Vec<&'a str>,
    pub(super) parents: Vec<&'a str>,
    pub(super) vouchers: Vec<Voucher<'a>>,
}

fn space(value: &str) -> bool {
    value
        .strip_prefix("replica:treehouse:space:")
        .and_then(|rest| rest.split_once("#authority:bounded-continuation-v1#root:"))
        .is_some_and(|(nonce, root)| {
            frame::identifier(nonce).is_ok() && frame::identifier(root).is_ok()
        })
}
fn ids(term: &Term, minimum: usize, maximum: usize) -> Option<Vec<&str>> {
    let values = list(term)?;
    if !(minimum..=maximum).contains(&values.len()) || !sorted_ids(term) {
        return None;
    }
    values.iter().map(text).collect()
}

impl<'a> Claim<'a> {
    pub fn decode(term: &'a Term) -> Option<Self> {
        let fields = closed(term, CLAIM_FIELDS)?;
        if integer(fields["version"])? != 1 || atom(fields["product"])? != "treehouse" {
            return None;
        }
        let replica = text(fields["space"])?;
        if !space(replica) {
            return None;
        }
        let old_pub = key(fields["old_pub"])?;
        let new_pub = key(fields["new_pub"])?;
        if old_pub == new_pub || !id(fields["old_admission"]) || key(fields["nonce"]).is_none() {
            return None;
        }
        let active = match atom(fields["old_membership"])? {
            "active" => true,
            "removed" => false,
            _ => return None,
        };
        let epoch = integer(fields["epoch"])?;
        if epoch > HORIZON {
            return None;
        }
        let raw_vouchers = list(fields["vouchers"])?;
        if raw_vouchers.len() != 2 {
            return None;
        }
        let mut vouchers = Vec::with_capacity(2);
        for raw in raw_vouchers {
            let voucher = closed(raw, &["member", "admission"])?;
            let member = key(voucher["member"])?;
            if member == old_pub || member == new_pub || !id(voucher["admission"]) {
                return None;
            }
            vouchers.push(Voucher {
                member,
                admission: text(voucher["admission"])?,
            });
        }
        if vouchers[0].member >= vouchers[1].member {
            return None;
        }
        Some(Self {
            term,
            space: replica,
            old_pub,
            new_pub,
            old_admission: text(fields["old_admission"])?,
            active,
            deps: ids(fields["deps"], 1, usize::MAX)?,
            epoch,
            epoch_basis: ids(fields["epoch_basis"], 1, usize::MAX)?,
            parents: ids(fields["parents"], 0, 16)?,
            vouchers,
        })
    }
    pub fn id(&self) -> Option<String> {
        digest("treehouse-member-key-claim-v1", self.term)
    }
    pub fn claim_bytes(&self) -> Option<Vec<u8>> {
        domain("treehouse-member-key-claim-v1", self.term)
    }
    pub fn possession_bytes(&self) -> Option<Vec<u8>> {
        domain("treehouse-member-key-possession-v1", self.term)
    }
    pub fn vouch_bytes(&self, possession: &[u8]) -> Option<Vec<u8>> {
        if possession.len() != 64 {
            return None;
        }
        encode(&Term::List(vec![
            bin("treehouse-member-key-vouch-v1"),
            self.term.clone(),
            Term::Binary(possession.to_vec()),
        ]))
        .ok()
    }
}

#[derive(Debug)]
pub struct Certificate<'a> {
    pub(super) claim: Claim<'a>,
    possession: &'a [u8],
    vouches: Vec<(&'a [u8], &'a [u8])>,
}
impl<'a> Certificate<'a> {
    pub fn decode(term: &'a Term) -> Option<Self> {
        let fields = closed(term, &["claim", "possession", "vouches"])?;
        Self::from_fields(fields["claim"], fields["possession"], fields["vouches"])
    }
    pub(super) fn decode_args(args: &'a [Term]) -> Option<Self> {
        let [claim, possession, vouches] = args else {
            return None;
        };
        Self::from_fields(claim, possession, vouches)
    }
    fn from_fields(claim: &'a Term, possession: &'a Term, vouches: &'a Term) -> Option<Self> {
        let claim = Claim::decode(claim)?;
        let possession = binary(possession).filter(|sig| sig.len() == 64)?;
        let values = list(vouches)?;
        if values.len() != 2 {
            return None;
        }
        let mut vouches = Vec::with_capacity(2);
        for (raw, expected) in values.iter().zip(&claim.vouchers) {
            let fields = closed(raw, &["member", "signature"])?;
            let member = key(fields["member"])?;
            if member != expected.member {
                return None;
            }
            let signature = binary(fields["signature"]).filter(|sig| sig.len() == 64)?;
            vouches.push((member, signature));
        }
        Some(Self {
            claim,
            possession,
            vouches,
        })
    }
    pub fn claim(&self) -> &Claim<'a> {
        &self.claim
    }
    pub fn verify(&self) -> bool {
        let Some(possession_bytes) = self.claim.possession_bytes() else {
            return false;
        };
        if frame::verify_signature(self.claim.new_pub, &possession_bytes, self.possession).is_err()
        {
            return false;
        }
        let Some(vouch_bytes) = self.claim.vouch_bytes(self.possession) else {
            return false;
        };
        self.vouches
            .iter()
            .all(|(member, sig)| frame::verify_signature(member, &vouch_bytes, sig).is_ok())
    }
}
