//! Pure native catalog evidence evaluation; no installed trust, custody or routes.
//! Authenticity remains separate from vocabulary/admission and authority.
pub mod artifact;
pub mod canonical;
pub mod cutoff;
pub mod delegations;
pub mod entries;
pub mod envelope;
pub mod frame;
pub mod history;
pub mod json;

pub mod authority;
pub mod commands;
mod evidence_terms;

mod bootstrap;
pub mod member_certificate;
mod projection;
pub mod reader;
pub mod space_policy;
pub mod space_projection;
pub mod thread_policy;

pub mod rotation;
