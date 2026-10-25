//! Pure native catalog evidence evaluation; no installed trust, custody or routes.
//! Authenticity remains separate from vocabulary/admission and authority.
pub mod canonical;
pub mod cutoff;
pub mod delegations;
pub mod envelope;
pub mod frame;
pub mod history;
pub mod json;

pub mod authority;
pub mod commands;
mod evidence_terms;

pub mod reader;
