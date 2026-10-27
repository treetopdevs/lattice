//! Shared deterministic projection ordering over the complete authenticated DAG.
use super::history::AuthenticDag;
use std::collections::BTreeMap;
pub(super) type Stamp<'a> = (usize, &'a str);
pub(super) fn heights(dag: &AuthenticDag) -> BTreeMap<&str, usize> {
    let mut heights = BTreeMap::new();
    for id in dag.order() {
        let depth = dag
            .frame(id)
            .expect("authenticated order")
            .deps()
            .iter()
            .map(|id| heights[id.as_str()])
            .max()
            .map_or(0, |depth: usize| depth + 1);
        heights.insert(id.as_str(), depth);
    }
    heights
}
pub(super) fn latest<'a>(
    slot: &mut Option<(Stamp<'a>, &'a str)>,
    stamp: Stamp<'a>,
    value: &'a str,
) {
    if slot.as_ref().is_none_or(|(previous, _)| stamp > *previous) {
        *slot = Some((stamp, value));
    }
}
