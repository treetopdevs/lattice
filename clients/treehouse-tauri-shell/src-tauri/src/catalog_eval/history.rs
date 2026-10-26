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
        if replica.is_empty() || replica.len() > frame::MAX_FRAME_BYTES {
            return Err(HistoryError::invalid());
        }
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
