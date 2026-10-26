//! Authenticated DAG groundwork for the native authority fold. This type proves
//! signatures, exact replica scope and closure only, never semantic authority or
//! a portable cutoff. Raw-history rejected evidence and trust policy are later
//! layers; callers cannot manufacture this proof from a saved decision.
use super::frame::{self, AuthenticFrame};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct HistoryError {
    pub reason: &'static str,
    pub ids: Vec<String>,
}
impl HistoryError {
    fn invalid() -> Self {
        Self {
            reason: "invalid_verified_history",
            ids: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub struct AuthenticDag {
    replica: String,
    frames: BTreeMap<String, Arc<AuthenticFrame>>,
    order: Vec<String>,
    frontier: Vec<String>,
}
impl AuthenticDag {
    /// Authenticate all frames before reporting missing ancestors. The byte cap
    /// counts encoded frames and their JSON array punctuation before allocation.
    pub fn authenticate(replica: &str, raw: &[&[u8]]) -> Result<Self, HistoryError> {
        let mut bytes = 2usize;
        for (index, frame) in raw.iter().enumerate() {
            bytes = bytes
                .checked_add(frame.len())
                .and_then(|n| n.checked_add(usize::from(index > 0)))
                .ok_or_else(HistoryError::invalid)?;
            if frame.is_empty() || frame.len() > frame::MAX_FRAME_BYTES || bytes > MAX_SOURCE_BYTES
            {
                return Err(HistoryError::invalid());
            }
        }
        Self::authenticate_accounted(replica, raw)
    }

    /// Internal complete-history construction after the owned history profile
    /// has accounted aggregate nodes/string bytes/depth. A retained union can
    /// exceed one external JSON transport's encoded size. This preserves every
    /// per-frame bound, signature/hash check, replica check and closure check;
    /// it is not an authenticity or authority bypass.
    pub(super) fn authenticate_accounted(
        replica: &str,
        raw: &[&[u8]],
    ) -> Result<Self, HistoryError> {
        if replica.is_empty() || replica.len() > frame::MAX_FRAME_BYTES {
            return Err(HistoryError::invalid());
        }
        let mut frames = BTreeMap::new();
        for bytes in raw {
            let frame = frame::verify(bytes).map_err(|_| HistoryError::invalid())?;
            if frame.replica() != replica || frames.contains_key(frame.id()) {
                return Err(HistoryError::invalid());
            }
            frames.insert(frame.id().to_owned(), Arc::new(frame));
        }
        let missing: BTreeSet<_> = frames
            .values()
            .flat_map(|frame| frame.deps())
            .filter(|id| !frames.contains_key(*id))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Err(HistoryError {
                reason: "trust_pending",
                ids: missing.into_iter().collect(),
            });
        }
        let edges: BTreeMap<_, _> = frames
            .iter()
            .map(|(id, frame)| (id.clone(), frame.deps().to_vec()))
            .collect();
        let order = canonical_order(&edges)?;
        let referenced: BTreeSet<_> = edges.values().flatten().collect();
        let frontier = frames
            .keys()
            .filter(|id| !referenced.contains(id))
            .cloned()
            .collect();
        Ok(Self {
            replica: replica.to_owned(),
            frames,
            order,
            frontier,
        })
    }

    pub fn replica(&self) -> &str {
        &self.replica
    }
    pub fn order(&self) -> &[String] {
        &self.order
    }
    pub fn frontier(&self) -> &[String] {
        &self.frontier
    }
    pub fn frame(&self, id: &str) -> Option<&AuthenticFrame> {
        self.frames.get(id).map(Arc::as_ref)
    }

    /// Derive a closed historical view from already authenticated immutable
    /// frames. Duplicate/redundant frontier ids normalize to the actual frontier;
    /// the future checkpoint owner must compare that frontier with its witness.
    /// An unknown requested id returns None, leaving context-specific recovery
    /// versus pending classification to that owner. No authority is established.
    pub fn causal_slice(&self, frontier: &[String]) -> Option<Self> {
        let mut pending = BTreeSet::new();
        for id in frontier {
            // Insert only known frame ids, bounding the work set by this DAG
            // even when a caller supplies a repeated frontier.
            pending.insert(self.frames.get(id)?.id());
        }
        let mut selected = BTreeSet::new();
        while let Some(id) = pending.pop_first() {
            if selected.insert(id) {
                pending.extend(self.frames[id].deps().iter().map(String::as_str));
            }
        }
        let frames: BTreeMap<_, _> = selected
            .into_iter()
            .map(|id| (id.to_owned(), Arc::clone(&self.frames[id])))
            .collect();
        let edges: BTreeMap<_, _> = frames
            .iter()
            .map(|(id, frame)| (id.clone(), frame.deps().to_vec()))
            .collect();
        let order = canonical_order(&edges).ok()?;
        let referenced: BTreeSet<_> = edges.values().flatten().collect();
        let frontier = frames
            .keys()
            .filter(|id| !referenced.contains(id))
            .cloned()
            .collect();
        Some(Self {
            replica: self.replica.clone(),
            frames,
            order,
            frontier,
        })
    }

    /// Exclusive causal past. Iterative traversal avoids stack growth on long
    /// authentic chains and allocates only the requested past, not all pairs.
    pub fn ancestors(&self, id: &str) -> Option<BTreeSet<&str>> {
        let start = self.frames.get(id)?;
        let mut found = BTreeSet::new();
        let mut pending: Vec<_> = start.deps().iter().map(String::as_str).collect();
        while let Some(id) = pending.pop() {
            if found.insert(id) {
                pending.extend(self.frames[id].deps().iter().map(String::as_str));
            }
        }
        Some(found)
    }
}

fn canonical_order(edges: &BTreeMap<String, Vec<String>>) -> Result<Vec<String>, HistoryError> {
    let mut incoming: BTreeMap<_, _> = edges
        .iter()
        .map(|(id, deps)| (id.as_str(), deps.len()))
        .collect();
    let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (id, deps) in edges {
        for dep in deps {
            if !edges.contains_key(dep) {
                return Err(HistoryError::invalid());
            }
            children.entry(dep).or_default().push(id);
        }
    }
    let mut ready: BTreeSet<_> = incoming
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut out = Vec::with_capacity(edges.len());
    while let Some(id) = ready.pop_first() {
        out.push(id.to_owned());
        for child in children.get(id).into_iter().flatten() {
            let count = incoming.get_mut(child).ok_or_else(HistoryError::invalid)?;
            *count -= 1;
            if *count == 0 {
                ready.insert(*child);
            }
        }
    }
    if out.len() != edges.len() {
        return Err(HistoryError::invalid());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn internal_graph_cycles_and_missing_nodes_fail_closed() {
        for edges in [
            BTreeMap::from([
                ("a".to_owned(), vec!["b".to_owned()]),
                ("b".to_owned(), vec!["a".to_owned()]),
            ]),
            BTreeMap::from([("a".to_owned(), vec!["a".to_owned()])]),
            BTreeMap::from([("a".to_owned(), vec!["missing".to_owned()])]),
        ] {
            assert_eq!(
                canonical_order(&edges).unwrap_err().reason,
                "invalid_verified_history"
            );
        }
    }
}

#[cfg(test)]
mod owned_union_tests {
    use super::super::canonical::{encode_op_payload, Term};
    use super::*;
    use base64::{
        engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
        Engine,
    };
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;
    use sha2::{Digest, Sha256};

    #[test]
    fn accounted_union_can_exceed_one_transport_without_widening_public_dag_input() {
        let signer = SigningKey::from_bytes(&[89; 32]);
        let replica = format!(
            "replica:treehouse:thread:{}#authority:bounded-continuation-v1#root:{}",
            URL_SAFE_NO_PAD.encode([90u8; 32]),
            URL_SAFE_NO_PAD.encode([91u8; 32])
        );
        let author = signer.verifying_key().to_bytes();
        let mut frames = Vec::with_capacity(1300);
        for index in 0..1300u64 {
            let mut values = vec![Term::Nil; 7000];
            values.push(Term::Integer(index));
            let body = Term::List(values);
            let payload = encode_op_payload(
                &[
                    Term::Binary(b"lattice-op-v2".to_vec()),
                    Term::Binary(replica.as_bytes().to_vec()),
                    Term::Binary(author.to_vec()),
                    Term::List(Vec::new()),
                    Term::Atom("command".into()),
                    body,
                    Term::Nil,
                ],
                false,
            )
            .unwrap();
            let mut values = vec![json!(["nil"]); 7000];
            values.push(json!(["int", index]));
            frames.push(serde_json::to_vec(&json!({"v":1,"id":URL_SAFE_NO_PAD.encode(Sha256::digest(&payload)),
                "replica":replica,"author":STANDARD.encode(author),"deps":[],"kind":"command",
                "body":["list",values],"cap":["nil"],"sig":STANDARD.encode(signer.sign(&payload).to_bytes())})).unwrap());
        }
        let refs: Vec<_> = frames.iter().map(Vec::as_slice).collect();
        let encoded = 2 + frames.iter().map(Vec::len).sum::<usize>() + frames.len() - 1;
        assert!(encoded > MAX_SOURCE_BYTES);
        assert!(frames
            .iter()
            .all(|frame| frame.len() < frame::MAX_FRAME_BYTES));
        //300 saved frames fit the32MiB retained input,1000 incoming frames fit
        //64MiB transport. The union has <30MiB strings and <20Mi nodes; nil
        //JSON wrappers make encoded bytes larger than either source metric.
        assert!(frames[..300].iter().map(Vec::len).sum::<usize>() < 32 * 1024 * 1024);
        assert!(frames[300..].iter().map(Vec::len).sum::<usize>() < 64 * 1024 * 1024);
        assert_eq!(
            AuthenticDag::authenticate(&replica, &refs)
                .unwrap_err()
                .reason,
            "invalid_verified_history"
        );
        let dag = AuthenticDag::authenticate_accounted(&replica, &refs).unwrap();
        assert_eq!(dag.order().len(), 1300);
        assert_eq!(dag.frontier().len(), 1300);
        //The internal path still authenticates all records, including the last.
        let mut forged = serde_json::from_slice::<serde_json::Value>(&frames[1299]).unwrap();
        forged["sig"] = json!(STANDARD.encode([0u8; 64]));
        let forged = serde_json::to_vec(&forged).unwrap();
        let mut bad_refs = refs;
        bad_refs[1299] = &forged;
        assert_eq!(
            AuthenticDag::authenticate_accounted(&replica, &bad_refs)
                .unwrap_err()
                .reason,
            "invalid_verified_history"
        );
    }
}
