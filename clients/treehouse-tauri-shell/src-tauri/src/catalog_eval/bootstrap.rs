//! Closed bootstrap record shape. Selecting a pin and establishing catalog trust
//! require authenticated history; a parsed record supplies neither.
use super::{canonical::Term, evidence_terms::*};

pub(super) struct Bootstrap<'a> {
    pub space: &'a str,
    pub root: &'a [u8],
    pub profile_genesis: &'a str,
    pub profile_id: &'a str,
}
impl<'a> Bootstrap<'a> {
    pub fn decode(term: &'a Term) -> Option<Self> {
        let m = closed(
            term,
            &[
                "version",
                "product",
                "space",
                "space_root",
                "profile_genesis",
                "profile_id",
                "replacement_rule",
                "catalog_key",
                "service_id",
                "service_key",
                "origin",
                "nonce",
            ],
        )?;
        if integer(m["version"]) != Some(1)
            || atom(m["product"]) != Some("treehouse")
            || atom(m["replacement_rule"]) != Some("bounded_space_admin_v1")
            || !id(m["profile_genesis"])
            || !id(m["profile_id"])
            || !id(m["service_id"])
            || !id(m["nonce"])
            || key(m["catalog_key"])? == key(m["service_key"])?
            || !origin(text(m["origin"])?)
        {
            return None;
        }
        let space = text(m["space"])?;
        if space.is_empty() {
            return None;
        }
        Some(Self {
            space,
            root: key(m["space_root"])?,
            profile_genesis: text(m["profile_genesis"])?,
            profile_id: text(m["profile_id"])?,
        })
    }
}

fn origin(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("wss://") else {
        return false;
    };
    let (host, port) = rest
        .split_once(':')
        .map_or((rest, None), |(h, p)| (h, Some(p)));
    if let Some(port) = port {
        if port.is_empty()
            || port.starts_with('0')
            || port.len() > 5
            || port == "443"
            || !port.bytes().all(|b| b.is_ascii_digit())
            || !port.parse::<u16>().is_ok_and(|p| p > 0)
        {
            return false;
        }
    }
    if host.len() > 253 {
        return false;
    }
    let labels: Vec<_> = host.split('.').collect();
    if labels.iter().any(|s| {
        s.is_empty()
            || s.len() > 63
            || !s
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || s.starts_with('-')
            || s.ends_with('-')
    }) {
        return false;
    }
    let last = labels.last().expect("split yields a label");
    !(last.bytes().all(|b| b.is_ascii_digit())
        || last
            .strip_prefix("0x")
            .is_some_and(|v| v.bytes().all(|b| b.is_ascii_hexdigit())))
}
