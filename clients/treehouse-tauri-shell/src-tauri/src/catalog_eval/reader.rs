//! Product-reader portability of an already authenticated frame. This proof is
//! narrower than semantic normalization: no payload, policy, honor or route is
//! inferred. Cutoff observation must still precede this stage for incoming trust.
use super::{
    cutoff::known_atom,
    frame::{self, AuthenticFrame},
};
use serde_json::Value;

const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
pub struct ReadableFrame(AuthenticFrame);
impl ReadableFrame {
    pub fn verify(bytes: &[u8]) -> Result<Self, &'static str> {
        let frame = frame::verify(bytes)?;
        // Preserve numeric-vs-text and null-vs-absent distinctions erased by
        // canonical terms. Authentication and the existing frame cap run first.
        let raw = super::json::parse(bytes)?;
        if !body_readable(&raw) || !readable(&raw["cap"], Context::Strict) {
            return Err("unsupported_cutoff");
        }
        Ok(Self(frame))
    }
    pub fn frame(&self) -> &AuthenticFrame {
        &self.0
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Context {
    Strict,
    Metadata,
    Certificate,
    Claim,
}
fn atom(term: &Value, name: &str) -> bool {
    term[0] == "atom" && term[1] == name
}
fn body_readable(frame: &Value) -> bool {
    let body = &frame["body"];
    if frame["kind"] == "authority" && body[0] == "tuple" {
        let values = body[1].as_array().expect("authenticated tuple");
        match values.as_slice() {
            [tag, epoch] if atom(tag, "beacon") && epoch[0] == "int" => return true,
            [tag, epoch, certificate] if atom(tag, "beacon") => {
                return readable(epoch, Context::Strict)
                    && readable(certificate, Context::Certificate);
            }
            [tag, delegation, policies] if atom(tag, "genesis") && policies[0] == "map" => {
                return readable(delegation, Context::Strict)
                    && policies[1]
                        .as_array()
                        .expect("authenticated map")
                        .iter()
                        .all(|pair| {
                            readable(&pair[0], Context::Strict)
                                && readable(
                                    &pair[1],
                                    if atom(&pair[0], "__beacon__") {
                                        Context::Metadata
                                    } else {
                                        Context::Strict
                                    },
                                )
                        });
            }
            _ => {}
        }
    }
    readable(body, Context::Strict)
}
fn readable(term: &Value, context: Context) -> bool {
    let child = if context == Context::Strict {
        Context::Strict
    } else {
        Context::Metadata
    };
    match term[0].as_str().expect("authenticated term tag") {
        "nil" | "bool" | "bin" => true,
        "int" => {
            let value = term[1]
                .as_u64()
                .or_else(|| term[1].as_str()?.parse::<u64>().ok())
                .expect("authenticated integer");
            value <= MAX_SAFE || context != Context::Strict
        }
        "atom" => known_atom(term[1].as_str().expect("authenticated atom")),
        "list" | "tuple" | "mapset" => term[1]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| readable(v, child)),
        "map" => term[1].as_array().unwrap().iter().all(|pair| {
            let key = &pair[0];
            let value = &pair[1];
            let value_context = if context == Context::Certificate && atom(key, "claim") {
                Context::Claim
            } else if context == Context::Claim && atom(key, "epoch") && value[0] == "int" {
                Context::Strict
            } else {
                child
            };
            readable(key, child) && readable(value, value_context)
        }),
        "delegation" => {
            let record = &term[1];
            ["ops", "roles"].iter().all(|field| {
                record[field]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|v| known_atom(v.as_str().unwrap()))
            }) && record
                .get("expires_epoch")
                .is_none_or(|v| v.as_u64().is_some_and(|n| n <= MAX_SAFE))
        }
        _ => false,
    }
}
