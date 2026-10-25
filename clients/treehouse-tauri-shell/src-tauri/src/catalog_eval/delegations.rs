//! Static delegation component of the authority fold. This is not an authority
//! verdict: roles, continuation, witnessed epochs and command policy are later
//! components. Raw authority tuples follow the BEAM static collector; semantic
//! history portability/normalization is a separate unfinished prerequisite of the
//! final evaluator. Only an authenticated, closed DAG constructs this analysis.
use super::{
    canonical::{encode, Term},
    frame,
    history::AuthenticDag,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Validation {
    Valid,
    Refused(&'static str),
    SuccessionCandidate(String),
}

#[derive(Clone, Debug)]
pub struct Delegation {
    id: String,
    replica: String,
    issuer: Vec<u8>,
    audience: Vec<u8>,
    parent: Option<String>,
    ops: BTreeSet<String>,
    roles: BTreeSet<String>,
    live: bool,
    expires: Option<u64>,
    signature: Vec<u8>,
}
impl Delegation {
    fn decode(term: &Term) -> Option<Self> {
        let Term::Delegation(v) = term else {
            return None;
        };
        if !matches!(v.len(), 9 | 10) {
            return None;
        }
        let Term::Bool(live) = &v[7] else { return None };
        let parent = match &v[4] {
            Term::Nil => None,
            term => Some(text(term)?.to_owned()),
        };
        let expires = match v.get(9) {
            None => None,
            Some(Term::Integer(n)) => Some(*n),
            _ => return None,
        };
        Some(Self {
            id: text(&v[0])?.into(),
            replica: text(&v[1])?.into(),
            issuer: binary(&v[2])?.into(),
            audience: binary(&v[3])?.into(),
            parent,
            ops: names(&v[5])?,
            roles: names(&v[6])?,
            live: *live,
            expires,
            signature: binary(&v[8])?.into(),
        })
    }
    fn signing_bytes(&self) -> Option<Vec<u8>> {
        let mut terms = vec![
            bin(if self.expires.is_some() {
                "lattice-delegation-v3"
            } else {
                "lattice-delegation-v2"
            }),
            bin(&self.replica),
            Term::Binary(self.issuer.clone()),
            Term::Binary(self.audience.clone()),
            self.parent.as_deref().map(bin).unwrap_or(Term::Nil),
            Term::List(self.ops.iter().cloned().map(Term::Atom).collect()),
            Term::List(self.roles.iter().cloned().map(Term::Atom).collect()),
            Term::Bool(self.live),
        ];
        if let Some(epoch) = self.expires {
            terms.push(Term::Integer(epoch));
        }
        encode(&Term::List(terms)).ok()
    }
    fn self_consistent(&self) -> bool {
        self.signing_bytes().is_some_and(|bytes| {
            URL_SAFE_NO_PAD.encode(Sha256::digest(&bytes)) == self.id
                && frame::verify_signature(&self.issuer, &bytes, &self.signature).is_ok()
        })
    }
    fn attenuates(&self, parent: &Self) -> bool {
        self.parent.as_deref() == Some(parent.id.as_str())
            && self.issuer == parent.audience
            && self.replica == parent.replica
            && self.ops.is_subset(&parent.ops)
            && self.roles.is_subset(&parent.roles)
            && (!self.live || parent.live)
            && match (self.expires, parent.expires) {
                (_, None) => true,
                (Some(child), Some(parent)) => child <= parent,
                _ => false,
            }
    }
    pub fn parent(&self) -> Option<&str> {
        self.parent.as_deref()
    }
}

#[derive(Debug)]
pub struct Record {
    delegation: Option<Delegation>,
    introductions: Vec<String>,
    invalid_introductions: BTreeMap<String, &'static str>,
    validation: Validation,
}
impl Record {
    pub fn validation(&self) -> &Validation {
        &self.validation
    }
    pub fn introductions(&self) -> &[String] {
        &self.introductions
    }
    pub fn invalid_introductions(&self) -> &BTreeMap<String, &'static str> {
        &self.invalid_introductions
    }
}

#[derive(Debug)]
pub struct StaticDelegations<'a> {
    dag: &'a AuthenticDag,
    records: BTreeMap<String, Record>,
    root: Option<Vec<u8>>,
    revokes: Vec<(String, String)>,
    reasons: BTreeMap<String, &'static str>,
}
impl<'a> StaticDelegations<'a> {
    /// Static chain/root/revoke analysis only. No active-capability or route API
    /// is exposed: a valid chain may be expired or lack an honored acquisition.
    pub fn analyze(dag: &'a AuthenticDag) -> Result<Self, &'static str> {
        if !bounded_family(dag.replica()) {
            return Err("unsupported_authority_profile");
        }
        let mut records = BTreeMap::<String, Record>::new();
        let mut genesis = BTreeSet::new();
        let mut succession = BTreeSet::new();
        let mut introductions = Vec::new();
        for id in dag.order() {
            let op = dag.frame(id).expect("authenticated DAG order");
            if op.kind() != "authority" {
                continue;
            }
            let Term::Tuple(body) = op.body() else {
                continue;
            };
            let (name, term) = match body.as_slice() {
                [Term::Atom(name), d, _] if name == "genesis" => (name, d),
                [Term::Atom(name), d] if name == "grant" => (name, d),
                [Term::Atom(name), _, d, Term::Integer(_)] if name == "transfer" => (name, d),
                [Term::Atom(name), _, d, _] if name == "succeed" => (name, d),
                _ => continue,
            };
            let Some(d) = Delegation::decode(term) else {
                return Err("invalid_verified_history");
            };
            if name == "genesis" {
                genesis.insert(d.id.clone());
            }
            if name == "succeed" {
                succession.insert(d.id.clone());
            }
            let good = d.self_consistent();
            let record = records.entry(d.id.clone()).or_insert_with(|| Record {
                delegation: None,
                introductions: Vec::new(),
                invalid_introductions: BTreeMap::new(),
                validation: Validation::Refused("bad_delegation_sig"),
            });
            if good {
                if record.delegation.is_none() {
                    record.delegation = Some(d.clone());
                }
                record.introductions.push(id.clone());
                introductions.push((id.clone(), name.clone(), d));
            } else {
                record
                    .invalid_introductions
                    .insert(id.clone(), "bad_delegation_sig");
            }
        }
        let mut cache = BTreeMap::new();
        for id in records.keys() {
            validate_chain(
                id,
                &records,
                &genesis,
                &succession,
                dag.replica(),
                &mut cache,
            );
        }
        for (id, record) in &mut records {
            record.validation = cache[id].clone();
        }
        let root = introductions.iter().find_map(|(_, kind, d)| {
            (kind == "genesis"
                && records[&d.id].validation == Validation::Valid
                && root_matches(dag.replica(), &d.audience))
            .then(|| d.audience.clone())
        });
        let mut reasons = BTreeMap::new();
        for record in records.values() {
            reasons.extend(record.invalid_introductions.clone());
            if record.delegation.is_some() {
                if let Validation::Refused(reason) = record.validation {
                    reasons.extend(record.introductions.iter().map(|id| (id.clone(), reason)));
                }
            }
        }
        for (id, kind, d) in &introductions {
            if kind != "genesis" {
                continue;
            }
            if d.parent.is_some() {
                reasons.insert(id.clone(), "invalid_genesis");
            } else if matches!(
                records[&d.id].validation,
                Validation::SuccessionCandidate(_)
            ) && !root_matches(dag.replica(), &d.audience)
            {
                reasons.insert(id.clone(), "impostor_genesis");
            }
        }
        let mut revokes = Vec::new();
        for id in dag.order() {
            let op = dag.frame(id).expect("authenticated DAG order");
            if op.kind() != "authority" {
                continue;
            }
            let Term::Tuple(body) = op.body() else {
                continue;
            };
            let [Term::Atom(name), target] = body.as_slice() else {
                continue;
            };
            if name != "revoke" {
                continue;
            }
            let Some(target) = text(target) else {
                return Err("invalid_verified_history");
            };
            let d = records.get(target).and_then(|r| r.delegation.as_ref());
            if d.is_some_and(|d| op.author() == d.issuer || root.as_deref() == Some(op.author())) {
                revokes.push((id.clone(), target.to_owned()));
            } else {
                reasons.insert(id.clone(), "unauthorized_revoke");
            }
        }
        Ok(Self {
            dag,
            records,
            root,
            revokes,
            reasons,
        })
    }
    pub fn records(&self) -> &BTreeMap<String, Record> {
        &self.records
    }
    pub fn root(&self) -> Option<&[u8]> {
        self.root.as_deref()
    }
    pub fn reasons(&self) -> &BTreeMap<String, &'static str> {
        &self.reasons
    }
    pub fn revokes(&self) -> &[(String, String)] {
        &self.revokes
    }
    /// Revocation component only, not the complete capability verdict. Unknown
    /// operations/delegations refuse the query rather than imply permission.
    pub fn revoked_as_of(&self, op_id: &str, delegation_id: &str) -> Option<bool> {
        self.dag.frame(op_id)?;
        self.records.get(delegation_id)?;
        let mut chain = BTreeSet::new();
        let mut current = Some(delegation_id);
        while let Some(id) = current {
            if !chain.insert(id) {
                break;
            }
            current = self
                .records
                .get(id)
                .and_then(|r| r.delegation.as_ref())
                .and_then(|d| d.parent());
        }
        Some(self.revokes.iter().any(|(revoke, target)| {
            chain.contains(target.as_str())
                && !self
                    .dag
                    .ancestors(revoke)
                    .expect("retained revoke")
                    .contains(op_id)
        }))
    }
}

// Each chain is walked iteratively and memoized. A long authentic delegation
// chain must not consume the native call stack or build an all-pairs matrix.
fn validate_chain(
    start: &str,
    records: &BTreeMap<String, Record>,
    genesis: &BTreeSet<String>,
    succession: &BTreeSet<String>,
    replica: &str,
    cache: &mut BTreeMap<String, Validation>,
) {
    let mut pending = Vec::new();
    let mut visiting = BTreeSet::new();
    let mut current = start;
    loop {
        if cache.contains_key(current) {
            break;
        }
        if !visiting.insert(current.to_owned()) {
            cache.insert(current.to_owned(), Validation::Refused("invalid_parent"));
            break;
        }
        let record = &records[current];
        let result = match &record.delegation {
            None => Some(Validation::Refused("bad_delegation_sig")),
            Some(d) if d.replica != replica => Some(Validation::Refused("wrong_replica")),
            Some(d) if d.parent.is_none() => Some(if d.issuer != d.audience {
                Validation::Refused("nongenesis_root")
            } else if genesis.contains(current) && root_matches(replica, &d.audience) {
                Validation::Valid
            } else if succession.contains(current) {
                Validation::SuccessionCandidate(current.into())
            } else if genesis.contains(current) {
                Validation::Refused("impostor_genesis")
            } else {
                Validation::Refused("unrooted_delegation")
            }),
            Some(d) => match records.get(d.parent.as_deref().unwrap()) {
                None => Some(Validation::Refused("missing_parent")),
                Some(parent) if parent.delegation.is_none() => {
                    Some(Validation::Refused("invalid_parent"))
                }
                _ => None,
            },
        };
        if let Some(result) = result {
            cache.insert(current.to_owned(), result);
            break;
        }
        pending.push(current.to_owned());
        current = records[current]
            .delegation
            .as_ref()
            .unwrap()
            .parent
            .as_deref()
            .unwrap();
    }
    while let Some(id) = pending.pop() {
        let d = records[&id].delegation.as_ref().unwrap();
        let parent = records[d.parent.as_deref().unwrap()]
            .delegation
            .as_ref()
            .unwrap();
        let result = if !d.attenuates(parent) {
            Validation::Refused("not_attenuated")
        } else {
            match &cache[&parent.id] {
                Validation::Valid => Validation::Valid,
                Validation::SuccessionCandidate(root) => {
                    Validation::SuccessionCandidate(root.clone())
                }
                _ => Validation::Refused("invalid_parent"),
            }
        };
        cache.insert(id, result);
    }
}
fn bin(s: &str) -> Term {
    Term::Binary(s.as_bytes().to_vec())
}
fn binary(term: &Term) -> Option<&[u8]> {
    if let Term::Binary(v) = term {
        Some(v)
    } else {
        None
    }
}
fn text(term: &Term) -> Option<&str> {
    std::str::from_utf8(binary(term)?).ok()
}
fn names(term: &Term) -> Option<BTreeSet<String>> {
    let Term::List(values) = term else {
        return None;
    };
    values
        .iter()
        .map(|v| {
            if let Term::Atom(s) = v {
                Some(s.clone())
            } else {
                None
            }
        })
        .collect()
}
fn root_matches(replica: &str, audience: &[u8]) -> bool {
    replica
        .split_once("#root:")
        .is_none_or(|(_, root)| URL_SAFE_NO_PAD.encode(Sha256::digest(audience)) == root)
}
fn bounded_family(replica: &str) -> bool {
    let Some(rest) = replica.strip_prefix("replica:treehouse:") else {
        return false;
    };
    let Some(rest) = rest
        .strip_prefix("space:")
        .or_else(|| rest.strip_prefix("thread:"))
    else {
        return false;
    };
    let Some((nonce, root)) = rest.split_once("#authority:bounded-continuation-v1#root:") else {
        return false;
    };
    [nonce, root].iter().all(|s| {
        s.len() == 43
            && URL_SAFE_NO_PAD
                .decode(s)
                .is_ok_and(|b| b.len() == 32 && URL_SAFE_NO_PAD.encode(b) == *s)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: usize, parent: Option<usize>) -> Record {
        Record {
            delegation: Some(Delegation {
                id: id.to_string(),
                replica: "test".into(),
                issuer: vec![1; 32],
                audience: vec![1; 32],
                parent: parent.map(|n| n.to_string()),
                ops: BTreeSet::new(),
                roles: BTreeSet::new(),
                live: false,
                expires: Some(10),
                signature: vec![],
            }),
            introductions: vec![],
            invalid_introductions: BTreeMap::new(),
            validation: Validation::Refused("unchecked"),
        }
    }
    #[test]
    fn long_chain_is_iterative_and_a_cycle_cannot_be_validated() {
        // Exercise the validation graph directly: collection independently
        // proves signatures, while content-addressed cycles are unconstructible.
        let mut records: BTreeMap<_, _> = (0..4096)
            .map(|n| (n.to_string(), record(n, n.checked_sub(1))))
            .collect();
        let mut cache = BTreeMap::new();
        validate_chain(
            "4095",
            &records,
            &BTreeSet::from(["0".into()]),
            &BTreeSet::new(),
            "test",
            &mut cache,
        );
        assert_eq!(cache.len(), 4096);
        assert!(cache.values().all(|v| *v == Validation::Valid));
        records
            .get_mut("0")
            .unwrap()
            .delegation
            .as_mut()
            .unwrap()
            .parent = Some("4095".into());
        cache.clear();
        validate_chain(
            "4095",
            &records,
            &BTreeSet::new(),
            &BTreeSet::new(),
            "test",
            &mut cache,
        );
        assert!(cache
            .values()
            .all(|v| *v == Validation::Refused("invalid_parent")));
    }
    #[test]
    fn attenuation_cannot_launder_live_roles_issuer_scope_or_lease() {
        let parent = record(0, None).delegation.unwrap();
        let child = record(1, Some(0)).delegation.unwrap();
        assert!(child.attenuates(&parent));
        let mutations: Vec<Box<dyn Fn(&mut Delegation)>> = vec![
            Box::new(|d| d.live = true),
            Box::new(|d| {
                d.roles.insert("moderator".into());
            }),
            Box::new(|d| d.issuer = vec![2; 32]),
            Box::new(|d| d.replica = "other".into()),
            Box::new(|d| d.expires = None),
            Box::new(|d| d.expires = Some(11)),
            Box::new(|d| d.parent = Some("other".into())),
        ];
        for mutate in mutations {
            let mut d = child.clone();
            mutate(&mut d);
            assert!(!d.attenuates(&parent));
        }
    }
}
